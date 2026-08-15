import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { MapNode } from '../../src/contracts/pipeline/pipeline-node.js';
import { mapControlDecisionStepName } from '../../src/dbos/dbos-names.js';
import { loadAllWorkflowSteps } from '../../src/dbos/read-model/dbos-step-pages.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { createRunManager } from '../../src/index.js';
import { createRootScopeId } from '../../src/pipeline/identity/execution-identity.js';
import {
  agentBinding,
  end,
  executionPlan,
  fromRunInput,
  routeOutcomes,
  sequence,
  task,
} from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const mapNode = (
  body: ReturnType<typeof task>,
  failure: MapNode['failure'] = { kind: 'collect' },
) => ({
  kind: 'map' as const,
  key: 'repositories',
  items: fromRunInput('/repositories'),
  itemKeyPath: '/id',
  maximumItems: 10,
  concurrency: 2,
  failure,
  body,
});

describe.sequential('RR-10 map lifecycle', () => {
  it('cancels two active effects without admitting or repeating the queued item', async () => {
    const executor = new ControlledRunExecutor();
    const manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    const runId = `map-external-cancel-${randomUUID()}`;
    const plan = executionPlan(sequence(mapNode(task('review')), end('succeeded')), {
      bindings: [agentBinding('repositories/review', 'reviewer')],
    });

    await manager.start();
    try {
      await manager.startRun({
        runId,
        executionPlan: plan,
        input: { repositories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      });
      await Promise.all([
        executor.expectStarted('main/repositories[a]/review'),
        executor.expectStarted('main/repositories[b]/review'),
      ]);

      await expect(manager.cancelRun({ runId, actorId: 'operator' })).resolves.toMatchObject({
        status: 'accepted',
      });
      await Promise.all([
        executor.expectAborted('main/repositories[a]/review'),
        executor.expectAborted('main/repositories[b]/review'),
      ]);
      await expect(manager.waitForTerminal(runId, { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: 'cancelled',
      });

      expect(executor.executionCount('main/repositories[a]/review')).toBe(1);
      expect(executor.executionCount('main/repositories[b]/review')).toBe(1);
      expect(executor.executionCount('main/repositories[c]/review')).toBe(0);
    } finally {
      await manager.stop();
    }
  }, 15_000);

  it('reads an in-flight fail-fast decision before its active sibling settles', async () => {
    const executor = new ControlledRunExecutor();
    const manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    const runId = `map-fail-fast-details-${randomUUID()}`;
    const plan = executionPlan(
      routeOutcomes(
        mapNode(task('review'), { kind: 'failFast', remaining: 'drain' }),
        { failed: end('failed') },
        end('succeeded'),
      ),
      { bindings: [agentBinding('repositories/review', 'reviewer')] },
    );
    const decisionName = mapControlDecisionStepName('main/repositories');
    const rootWorkflowId = scopeWorkflowId(
      createRootScopeId({ runId, rootPipelineId: plan.rootPipelineId }),
    );

    await manager.start();
    try {
      await manager.startRun({
        runId,
        executionPlan: plan,
        input: { repositories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      });
      await Promise.all([
        executor.expectStarted('main/repositories[a]/review'),
        executor.expectStarted('main/repositories[b]/review'),
      ]);
      await executor.fail('main/repositories[a]/review', 'review_failed');
      await expect
        .poll(
          async () =>
            (await loadAllWorkflowSteps(rootWorkflowId)).some(({ name }) => name === decisionName),
          { timeout: 5_000 },
        )
        .toBe(true);

      const inFlightDetails = await manager.getRunDetails(runId).catch((error: unknown) => error);
      await executor.complete('main/repositories[b]/review', {
        kind: 'completed',
        outcome: 'completed',
      });
      await expect(manager.waitForTerminal(runId, { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: 'failed',
      });
      expect(inFlightDetails).toMatchObject({
        run: { status: 'running' },
        mapExecutions: [
          {
            outcome: 'failed',
            remaining: 'drain',
            decisiveItemKey: 'a',
            summary: { totalItems: 3, completedItems: 0, failedItems: 1 },
          },
        ],
      });
    } finally {
      await manager.stop();
    }
  }, 15_000);

  it('keeps nested map, parallel, and repeat effects within the plan-wide provider cap', async () => {
    const executor = new ControlledRunExecutor();
    const manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    const runId = `map-global-cap-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'map',
          key: 'repositories',
          items: fromRunInput('/repositories'),
          itemKeyPath: '/id',
          maximumItems: 10,
          concurrency: 3,
          failure: { kind: 'collect' },
          body: {
            kind: 'parallel',
            key: 'checks',
            branches: {
              direct: task('direct'),
              loop: {
                kind: 'repeat',
                key: 'loop',
                maximumIterations: 1,
                continueOn: ['retry'],
                completeOn: ['completed'],
                body: task('work'),
              },
            },
            join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('repositories/checks/direct', 'reviewer'),
          agentBinding('repositories/checks/loop/work', 'reviewer'),
        ],
        policies: { maximumActiveNodeExecutions: 2 },
      },
    );
    const paths = ['a', 'b', 'c'].flatMap((key) => [
      `main/repositories[${key}]/checks/direct`,
      `main/repositories[${key}]/checks/loop[1]/work`,
    ]);

    await manager.start();
    try {
      await manager.startRun({
        runId,
        executionPlan: plan,
        input: { repositories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      });
      await executor.expectMaximumActiveExecutions(2);
      await Promise.all(
        paths.map((path) => executor.complete(path, { kind: 'completed', outcome: 'completed' })),
      );

      await expect(manager.waitForTerminal(runId, { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: 'succeeded',
      });
      executor.expectPeakActiveExecutions(2);
    } finally {
      await manager.stop();
    }
  }, 15_000);
});
