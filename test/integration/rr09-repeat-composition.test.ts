import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import {
  agentBinding,
  end,
  executionPlan,
  fromNodeOutput,
  sequence,
  task,
} from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

const startManager = async () => {
  const executor = new ControlledRunExecutor();
  manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
  await manager.start();
  return { executor, manager };
};

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe.sequential('RR-09 real DBOS repeat composition', () => {
  it('executes a parallel body in iteration-local durable scopes', async () => {
    const { executor, manager: runManager } = await startManager();
    const runId = `repeat-parallel-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'loop',
          maximumIterations: 1,
          continueOn: ['failed'],
          completeOn: ['succeeded'],
          body: {
            kind: 'parallel',
            key: 'group',
            branches: { a: task('a'), b: task('b') },
            join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [agentBinding('loop/group/a', 'worker'), agentBinding('loop/group/b', 'worker')],
      },
    );

    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await Promise.all([
      executor.expectStarted('main/loop[1]/group/a'),
      executor.expectStarted('main/loop[1]/group/b'),
    ]);
    await Promise.all([
      executor.complete('main/loop[1]/group/a', { kind: 'completed', outcome: 'completed' }),
      executor.complete('main/loop[1]/group/b', { kind: 'completed', outcome: 'completed' }),
    ]);
    await runManager.waitForTerminal(runId, { timeoutMs: 10_000 });

    const details = await runManager.getRunDetails(runId);
    expect(details?.scopes.map(({ kind, displayPath }) => [kind, displayPath])).toEqual([
      ['root', 'main'],
      ['repeatIteration', 'main/loop[1]'],
      ['parallelBranch', 'main/loop[1]/group/a'],
      ['parallelBranch', 'main/loop[1]/group/b'],
    ]);
    expect(details?.nodeInstances.map(({ displayPath }) => displayPath)).toEqual([
      'main/loop[1]/group/a',
      'main/loop[1]/group/b',
    ]);
  });

  it('forwards an optional subpipeline body output through the repeat result', async () => {
    const { executor, manager: runManager } = await startManager();
    const runId = `repeat-subpipeline-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'loop',
          maximumIterations: 1,
          continueOn: ['retry'],
          completeOn: ['approved'],
          body: { kind: 'subpipeline', key: 'phase', pipelineId: 'child' },
        },
        end('succeeded', {
          output: { result: fromNodeOutput('loop', undefined, 'result') },
        }),
      ),
      {
        pipelines: {
          child: sequence(
            task('work'),
            end('succeeded', {
              outcome: 'approved',
              output: { result: fromNodeOutput('work', undefined, 'result') },
            }),
          ),
        },
        bindings: [agentBinding('work', 'worker', { pipelineId: 'child' })],
      },
    );

    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await executor.complete('main/loop[1]/phase/work', {
      kind: 'completed',
      outcome: 'completed',
      output: { result: { kind: 'json', value: { approved: true } } },
    });
    const run = await runManager.waitForTerminal(runId, { timeoutMs: 10_000 });

    expect(run).toMatchObject({
      status: 'succeeded',
      result: {
        output: { result: { kind: 'json', value: { approved: true } } },
      },
    });
    expect((await runManager.getRunDetails(runId))?.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'repeatIteration', displayPath: 'main/loop[1]' }),
        expect.objectContaining({
          kind: 'inlineSubpipeline',
          displayPath: 'main/loop[1]/phase',
        }),
      ]),
    );
  });

  it('cancels an active body scope without admitting a later iteration', async () => {
    const { executor, manager: runManager } = await startManager();
    const runId = `repeat-cancel-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'loop',
          maximumIterations: 3,
          continueOn: ['retry'],
          completeOn: ['completed'],
          body: task('work'),
        },
        end('succeeded'),
      ),
      { bindings: [agentBinding('loop/work', 'worker')] },
    );

    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await executor.expectStarted('main/loop[1]/work');
    await runManager.cancelRun({ runId, actorId: 'operator' });
    await executor.expectAborted('main/loop[1]/work');
    await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'cancelled',
    });

    const details = await runManager.getRunDetails(runId);
    expect(details?.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'repeatIteration',
          displayPath: 'main/loop[1]',
          status: 'cancelled',
        }),
      ]),
    );
    expect(details?.scopes.some(({ displayPath }) => displayPath.includes('loop[2]'))).toBe(false);
    expect(executor.executionCount('main/loop[2]/work')).toBe(0);
  });

  it('does not let an outer repeat consume a nested unmatched failure', async () => {
    const { executor, manager: runManager } = await startManager();
    const runId = `nested-repeat-failure-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'outer',
          maximumIterations: 2,
          continueOn: ['retry'],
          completeOn: ['invalid'],
          body: {
            kind: 'repeat',
            key: 'inner',
            maximumIterations: 1,
            continueOn: ['retry'],
            completeOn: ['approved'],
            body: task('work'),
          },
        },
        end('succeeded'),
      ),
      { bindings: [agentBinding('outer/inner/work', 'worker')] },
    );

    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await executor.complete('main/outer[1]/inner[1]/work', {
      kind: 'completed',
      outcome: 'unexpected',
    });

    await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'failed',
      result: { outcome: 'invalid' },
    });
    expect(executor.executionCount('main/outer[2]/inner[1]/work')).toBe(0);
  });

  it('does not let outer outcome policy consume nested cancellation', async () => {
    const { executor, manager: runManager } = await startManager();
    const runId = `nested-repeat-cancel-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'outer',
          maximumIterations: 2,
          continueOn: ['retry'],
          completeOn: ['cancelled'],
          body: {
            kind: 'repeat',
            key: 'inner',
            maximumIterations: 2,
            continueOn: ['retry'],
            completeOn: ['approved'],
            body: task('work'),
          },
        },
        end('succeeded'),
      ),
      { bindings: [agentBinding('outer/inner/work', 'worker')] },
    );

    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await executor.expectStarted('main/outer[1]/inner[1]/work');
    await runManager.cancelRun({ runId, actorId: 'operator' });
    await executor.expectAborted('main/outer[1]/inner[1]/work');

    await expect(runManager.waitForTerminal(runId, { timeoutMs: 10_000 })).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(executor.executionCount('main/outer[1]/inner[2]/work')).toBe(0);
    expect(executor.executionCount('main/outer[2]/inner[1]/work')).toBe(0);
  });
});
