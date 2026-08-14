import { setTimeout as wait } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import type { RunExecutorRequest } from '../../src/index.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';

const request: RunExecutorRequest = {
  runId: 'delayed-dispatch',
  scopeId: `sc1_${'b'.repeat(43)}`,
  authoredNodeId: `an1_${'c'.repeat(43)}`,
  nodeInstanceId: `ni1_${'d'.repeat(43)}`,
  attemptId: `at1_${'a'.repeat(43)}`,
  attemptOrdinal: 1,
  displayPath: 'main/work',
  pipelineId: 'main',
  nodePath: 'work',
  binding: {
    kind: 'script',
    target: { pipelineId: 'main', nodePath: 'work' },
    script: { id: 'effect.run', revision: 1 },
  },
  input: {},
};

describe('controlled run executor', () => {
  it('waits beyond the default polling timeout for a valid dispatch', async () => {
    const executor = new ControlledRunExecutor();
    const completed = executor
      .complete('main/work', { kind: 'completed', outcome: 'completed' })
      .then(
        () => true,
        () => false,
      );

    await wait(1_100);
    const controller = new AbortController();
    const execution = executor.execute(request, { signal: controller.signal });
    const didComplete = await completed;

    if (!didComplete) {
      controller.abort(new Error('Completion stopped waiting before dispatch.'));
    }
    const executionOutcome = await execution.then(
      (result) => ({ kind: 'resolved', result }) as const,
      () => ({ kind: 'rejected' }) as const,
    );

    expect(didComplete).toBe(true);
    expect(executionOutcome).toStrictEqual({
      kind: 'resolved',
      result: { kind: 'completed', outcome: 'completed' },
    });
  });
});
