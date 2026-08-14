import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { ExecutionPlan, RunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

const delayedChild = sequence(
  task('ready'),
  { kind: 'delay', key: 'cooldown', durationMs: 60_000 },
  end('succeeded'),
);

const oneInlinePlan = (): ExecutionPlan =>
  executionPlan(
    sequence({ kind: 'subpipeline', key: 'phase', pipelineId: 'child' }, end('succeeded')),
    {
      pipelines: { child: delayedChild },
      bindings: [agentBinding('ready', 'worker', { pipelineId: 'child' })],
    },
  );

const twoInlinePlan = (): ExecutionPlan =>
  executionPlan(
    sequence({ kind: 'subpipeline', key: 'phase', pipelineId: 'first' }, end('succeeded')),
    {
      pipelines: {
        first: sequence(
          { kind: 'subpipeline', key: 'nested', pipelineId: 'second' },
          end('succeeded'),
        ),
        second: delayedChild,
      },
      bindings: [agentBinding('ready', 'worker', { pipelineId: 'second' })],
    },
  );

const repeatInlinePlan = (): ExecutionPlan =>
  executionPlan(
    sequence(
      {
        kind: 'repeat',
        key: 'loop',
        maximumIterations: 1,
        continueOn: ['retry'],
        completeOn: ['succeeded'],
        body: { kind: 'subpipeline', key: 'phase', pipelineId: 'child' },
      },
      end('succeeded'),
    ),
    {
      pipelines: { child: delayedChild },
      bindings: [agentBinding('ready', 'worker', { pipelineId: 'child' })],
    },
  );

const parallelInlinePlan = (): ExecutionPlan =>
  executionPlan(
    sequence(
      {
        kind: 'parallel',
        key: 'group',
        branches: {
          a: { kind: 'subpipeline', key: 'phase', pipelineId: 'child' },
        },
        join: { kind: 'all', successfulOutcomes: ['succeeded'], remaining: 'drain' },
      },
      end('succeeded'),
    ),
    {
      pipelines: { child: delayedChild },
      bindings: [agentBinding('ready', 'worker', { pipelineId: 'child' })],
    },
  );

const startRun = async (plan: ExecutionPlan, label: string) => {
  const executor = new ControlledRunExecutor();
  manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
  await manager.start();
  const runId = `${label}-${randomUUID()}`;
  await manager.startRun({ runId, executionPlan: plan, input: null });
  return { executor, manager, runId };
};

const cancelWaitingInlineDelay = async (
  plan: ExecutionPlan,
  label: string,
  taskPath: string,
  inlinePath: string,
): Promise<number> => {
  const { executor, manager: runManager, runId } = await startRun(plan, label);
  await executor.complete(taskPath, { kind: 'completed', outcome: 'completed' });
  await expect
    .poll(
      async () =>
        (await runManager.getRunEvents(runId, { limit: 100 })).items.some(
          ({ type }) => type === 'nodeExecution.completed',
        ),
      { timeout: 5_000 },
    )
    .toBe(true);

  await runManager.cancelRun({ runId, actorId: 'operator' });
  await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
    status: 'cancelled',
  });

  const details = await runManager.getRunDetails(runId);
  const inlineScope = details?.scopes.find(
    ({ kind, displayPath }) => kind === 'inlineSubpipeline' && displayPath === inlinePath,
  );
  expect(inlineScope).toBeDefined();
  const events = await runManager.getRunEvents(runId, { limit: 100 });
  const cancellationEvents = events.items.filter(({ type }) => type === 'delay.cancelled');
  expect(cancellationEvents).toHaveLength(1);
  expect(cancellationEvents[0]?.data).toMatchObject({ scopeId: inlineScope?.id });
  expect(events.items.map(({ type }) => type)).toEqual(
    expect.arrayContaining(['runCommand.accepted', 'delay.cancelled']),
  );
  return cancellationEvents.length;
};

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe.sequential('RR-09 inline delay cancellation ownership', () => {
  it('cancels a delay in one root-owned inline subpipeline', async () => {
    await expect(
      cancelWaitingInlineDelay(oneInlinePlan(), 'inline-delay', 'main/phase/ready', 'main/phase'),
    ).resolves.toBe(1);
  });

  it('cancels a delay in two nested root-owned inline subpipelines', async () => {
    await expect(
      cancelWaitingInlineDelay(
        twoInlinePlan(),
        'nested-inline-delay',
        'main/phase/nested/ready',
        'main/phase/nested',
      ),
    ).resolves.toBe(1);
  });

  it('cancels an inline delay owned by a repeat iteration workflow', async () => {
    await expect(
      cancelWaitingInlineDelay(
        repeatInlinePlan(),
        'repeat-inline-delay',
        'main/loop[1]/phase/ready',
        'main/loop[1]/phase',
      ),
    ).resolves.toBe(1);
  });

  it('cancels an inline delay owned by a parallel branch workflow', async () => {
    await expect(
      cancelWaitingInlineDelay(
        parallelInlinePlan(),
        'parallel-inline-delay',
        'main/group/phase/ready',
        'main/group/phase',
      ),
    ).resolves.toBe(1);
  });
});
