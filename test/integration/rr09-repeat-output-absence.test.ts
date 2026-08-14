import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { ExecutionPlan, RunManager } from '../../src/index.js';
import {
  agentBinding,
  end,
  executionPlan,
  fromIterationOutput,
  fromNodeOutput,
  routeOutcomes,
  sequence,
  task,
} from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

const startRun = async (plan: ExecutionPlan) => {
  const executor = new ControlledRunExecutor();
  manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
  await manager.start();
  const runId = `repeat-output-${randomUUID()}`;
  await manager.startRun({ runId, executionPlan: plan, input: null });
  return { executor, manager, runId };
};

const expectNoRunOutput = async (runManager: RunManager, runId: string): Promise<void> => {
  const run = await runManager.waitForTerminal(runId, { timeoutMs: 10_000 });
  expect('result' in run ? run.result.output : undefined).toBeUndefined();
};

const repeatTask = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  kind: 'repeat' as const,
  key: 'loop',
  maximumIterations: 1,
  continueOn: ['retry'],
  completeOn: ['completed'],
  body: task('work'),
  ...overrides,
});

const nestedRepeatPlan = (forwardOutput: boolean): ExecutionPlan =>
  executionPlan(
    sequence(
      {
        kind: 'repeat',
        key: 'outer',
        maximumIterations: 1,
        continueOn: ['retry'],
        completeOn: ['completed'],
        body: {
          kind: 'repeat',
          key: 'inner',
          maximumIterations: 1,
          continueOn: ['retry'],
          completeOn: ['approved'],
          body: task('work'),
        },
      },
      end('succeeded', {
        ...(forwardOutput
          ? { output: { result: fromNodeOutput('outer', undefined, 'result') } }
          : {}),
      }),
    ),
    { bindings: [agentBinding('outer/inner/work', 'worker')] },
  );

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe.sequential('RR-09 repeat output absence', () => {
  it('treats a completed task without output as harmless absence', async () => {
    const {
      executor,
      manager: runManager,
      runId,
    } = await startRun(
      executionPlan(sequence(repeatTask(), end('succeeded')), {
        bindings: [agentBinding('loop/work', 'worker')],
      }),
    );

    await executor.complete('main/loop[1]/work', {
      kind: 'completed',
      outcome: 'completed',
    });

    await expectNoRunOutput(runManager, runId);
    const details = await runManager.getRunDetails(runId);
    const attempt = details?.attempts.find(({ status }) => status === 'completed');
    expect(attempt?.status).toBe('completed');
    expect(attempt !== undefined && 'output' in attempt).toBe(false);
  });

  it('classifies an explicit next iterationOutput reference as unavailable', async () => {
    const plan = executionPlan(
      routeOutcomes(
        repeatTask({
          maximumIterations: 2,
          nextInput: { previous: fromIterationOutput() },
        }),
        { failed: end('failed') },
      ),
      { bindings: [agentBinding('loop/work', 'worker')] },
    );
    const { executor, manager: runManager, runId } = await startRun(plan);

    await executor.complete('main/loop[1]/work', { kind: 'completed', outcome: 'retry' });
    await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'failed',
    });

    const events = await runManager.getRunEvents(runId, { limit: 100 });
    const failure = events.items.find(({ type }) => type === 'inputResolution.failed');
    expect(failure?.data).toMatchObject({ errorCode: 'input_source_unavailable' });
    expect(executor.executionCount('main/loop[2]/work')).toBe(0);
  });

  it('returns exhausted without inventing output for the final task', async () => {
    const plan = executionPlan(routeOutcomes(repeatTask(), { exhausted: end('succeeded') }), {
      bindings: [agentBinding('loop/work', 'worker')],
    });
    const { executor, manager: runManager, runId } = await startRun(plan);

    await executor.complete('main/loop[1]/work', { kind: 'completed', outcome: 'retry' });

    await expectNoRunOutput(runManager, runId);
    const events = await runManager.getRunEvents(runId, { limit: 100 });
    expect(events.items.filter(({ type }) => type === 'repeat.exhausted')).toHaveLength(1);
  });

  it('reports node_output_not_found to a downstream reference', async () => {
    const plan = executionPlan(
      sequence(
        repeatTask(),
        task('consumer', { input: { previous: fromNodeOutput('loop') } }),
        end('succeeded'),
      ),
      {
        bindings: [agentBinding('loop/work', 'worker'), agentBinding('consumer', 'consumer')],
      },
    );
    const { executor, manager: runManager, runId } = await startRun(plan);

    await executor.complete('main/loop[1]/work', {
      kind: 'completed',
      outcome: 'completed',
    });
    await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'failed',
    });

    const events = await runManager.getRunEvents(runId, { limit: 100 });
    const failure = events.items.find(({ type }) => type === 'inputResolution.failed');
    expect(failure?.data).toMatchObject({ errorCode: 'node_output_not_found' });
    expect(executor.executionCount('main/consumer')).toBe(0);
  });

  it('forwards present output through nested repeat bodies', async () => {
    const { executor, manager: runManager, runId } = await startRun(nestedRepeatPlan(true));
    await executor.complete('main/outer[1]/inner[1]/work', {
      kind: 'completed',
      outcome: 'approved',
      output: { result: { kind: 'json', value: 'present' } },
    });

    await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'succeeded',
      result: { output: { result: { kind: 'json', value: 'present' } } },
    });
  });

  it('preserves absent output through nested repeat bodies', async () => {
    const { executor, manager: runManager, runId } = await startRun(nestedRepeatPlan(false));
    await executor.complete('main/outer[1]/inner[1]/work', {
      kind: 'completed',
      outcome: 'approved',
    });

    await expectNoRunOutput(runManager, runId);
    expect(executor.executionCount('main/outer[1]/inner[1]/work')).toBe(1);
  });
});
