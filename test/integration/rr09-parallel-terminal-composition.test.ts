import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { ParallelJoinPolicy, RunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

const startManager = async () => {
  const executor = new ControlledRunExecutor();
  manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
  await manager.start();
  return { executor, manager };
};

const terminalRepeat = {
  kind: 'repeat',
  key: 'inner',
  maximumIterations: 1,
  continueOn: ['retry'],
  completeOn: ['approved'],
  body: task('invalid'),
} as const;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe.sequential('RR-09 parallel terminal composition', () => {
  it.each<readonly [string, ParallelJoinPolicy]>([
    ['all', { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' }],
    ['any', { kind: 'any', successfulOutcomes: ['completed'], remaining: 'drain' }],
    [
      'threshold',
      { kind: 'threshold', count: 1, successfulOutcomes: ['completed'], remaining: 'drain' },
    ],
  ])('propagates an unmatched N=1 repeat through a %s join', async (label, join) => {
    const { executor, manager: runManager } = await startManager();
    const runId = `parallel-terminal-${label}-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'review',
          branches: { terminal: terminalRepeat, success: task('success') },
          join,
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('review/inner/invalid', 'worker'),
          agentBinding('review/success', 'worker'),
        ],
        policies: { maximumActiveNodeExecutions: 2 },
      },
    );

    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await Promise.all([
      executor.expectStarted('main/review/inner[1]/invalid'),
      executor.expectStarted('main/review/success'),
    ]);
    await executor.complete('main/review/inner[1]/invalid', {
      kind: 'completed',
      outcome: 'unexpected',
    });
    await expect
      .poll(
        async () =>
          (await runManager.getRunEvents(runId, { limit: 100 })).items.some(
            ({ type }) => type === 'pipeline.invalidState',
          ),
        { timeout: 5_000 },
      )
      .toBe(true);
    await executor.complete('main/review/success', {
      kind: 'completed',
      outcome: 'completed',
      output: { ignored: { kind: 'json', value: 'terminal-wins' } },
    });

    const run = await runManager.waitForTerminal(runId, { timeoutMs: 10_000 });
    expect(run).toMatchObject({
      status: 'failed',
      result: { outcome: 'invalid' },
    });
    expect('result' in run ? run.result.output : undefined).toBeUndefined();
  });

  it('propagates a parallel terminal through an outer repeat policy', async () => {
    const { executor, manager: runManager } = await startManager();
    const runId = `repeat-parallel-terminal-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'outer',
          maximumIterations: 2,
          continueOn: ['retry'],
          completeOn: ['invalid'],
          body: {
            kind: 'parallel',
            key: 'review',
            branches: { terminal: terminalRepeat },
            join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
          },
        },
        end('succeeded'),
      ),
      { bindings: [agentBinding('outer/review/inner/invalid', 'worker')] },
    );

    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await executor.complete('main/outer[1]/review/inner[1]/invalid', {
      kind: 'completed',
      outcome: 'unexpected',
    });

    await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'failed',
      result: { outcome: 'invalid' },
    });
    expect(executor.executionCount('main/outer[2]/review/inner[1]/invalid')).toBe(0);
  });
});
