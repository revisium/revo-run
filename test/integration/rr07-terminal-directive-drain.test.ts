import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { loadAllWorkflowSteps } from '../../src/dbos/read-model/dbos-step-pages.js';
import { scopeWorkflowV2Id } from '../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import {
  createAuthoredNodeId,
  createParallelBranchScopeId,
  createRootScopeId,
} from '../../src/pipeline/identity/execution-identity.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const receiveOutputs = async (workflowId: string): Promise<readonly unknown[]> =>
  (await loadAllWorkflowSteps(workflowId))
    .filter(({ name }) => name === 'DBOS.recv')
    .map(({ output }) => output);

const isCancel = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'cancel';

describe('RR-07 terminal directive draining', () => {
  it('durably observes cancellation after provider abort and cancelled-child propagation', async () => {
    const executor = new ControlledRunExecutor();
    const runtime = new DbosRunRuntime(testDatabaseUrl(), executor, new WorkflowRegistry());
    const runId = `terminal-directive-drain-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'work',
          branches: { first: task('first'), second: task('second') },
          join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('work/first', 'developer'),
          agentBinding('work/second', 'developer'),
        ],
        policies: { maximumActiveNodeExecutions: 2 },
      },
    );
    const rootScopeId = createRootScopeId({ runId, rootPipelineId: 'main' });
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: 1,
      pipelineId: 'main',
      nodePath: 'work',
      nodeKind: 'parallel',
    });
    const scopeWorkflowIds = [
      ['root', scopeWorkflowV2Id(rootScopeId)],
      ...['first', 'second'].map(
        (branchKey) =>
          [
            branchKey,
            scopeWorkflowV2Id(
              createParallelBranchScopeId({
                parentScopeId: rootScopeId,
                authoredNodeId,
                branchKey,
              }),
            ),
          ] as const,
      ),
    ] as const;

    await runtime.start();
    try {
      await runtime.startRun(runId, plan, null);
      await Promise.all([
        executor.expectStarted('main/work/first'),
        executor.expectStarted('main/work/second'),
      ]);

      await expect(runtime.cancelRun({ runId, actorId: 'operator' })).resolves.toMatchObject({
        status: 'accepted',
      });
      await Promise.all([
        executor.expectAborted('main/work/first'),
        executor.expectAborted('main/work/second'),
      ]);
      await expect(
        runtime.waitForTerminal(runId, { timeoutMs: 10_000 }, new AbortController().signal),
      ).resolves.toMatchObject({ status: 'cancelled' });

      const allReceives = await Promise.all(
        scopeWorkflowIds.map(async ([label, workflowId]) => ({
          label,
          values: await receiveOutputs(workflowId),
        })),
      );
      const [root, ...branches] = allReceives;
      if (root === undefined) {
        throw new Error('Root scope receive history is missing.');
      }
      const rootReceives = root.values;
      expect(rootReceives.filter(isCancel), 'root terminal drain').toStrictEqual([
        { kind: 'cancel' },
      ]);
      expect(rootReceives.at(-1), 'root final receive').toStrictEqual({ kind: 'cancel' });
      for (const { label, values: receives } of branches) {
        expect(receives.filter(isCancel), `${label} finish drain`).toStrictEqual([
          { kind: 'cancel' },
          { kind: 'cancel' },
        ]);
        expect(receives.at(-1), `${label} terminal drain`).toBeNull();
      }
      expect(executor.executionCount('main/work/first')).toBe(1);
      expect(executor.executionCount('main/work/second')).toBe(1);
    } finally {
      await runtime.stop();
    }
  }, 20_000);
});
