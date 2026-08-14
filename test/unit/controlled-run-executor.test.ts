import { setTimeout as wait } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

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

const requestForAttempt = (attemptOrdinal: number, idCharacter: string): RunExecutorRequest => ({
  ...request,
  attemptId: `at1_${idCharacter.repeat(43)}`,
  attemptOrdinal,
});

describe('controlled run executor', () => {
  it('waits through the acceptance observation window for a valid dispatch', async () => {
    const executor = new ControlledRunExecutor();
    const completed = executor
      .complete('main/work', { kind: 'completed', outcome: 'completed' })
      .then(
        () => true,
        () => false,
      );

    await wait(5_100);
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
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
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
  }, 12_000);

  it('reports the exact unmet condition at the shared observation deadline', async () => {
    vi.useFakeTimers();
    try {
      const timedOut = new ControlledRunExecutor()
        .expectStarted('main/missing')
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10_000);

      const error = await timedOut;
      expect(error).toBeInstanceOf(Error);
      expect(error).toEqual(
        expect.objectContaining({
          message: 'Execution main/missing was not dispatched within 10000 ms.',
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets concurrent waiters for one ordinal claim another attempt', async () => {
    const executor = new ControlledRunExecutor();
    const firstCompletion = executor.complete(
      'main/work',
      { kind: 'completed', outcome: 'first-attempt-one' },
      1,
    );
    let secondCompleted = false;
    const secondCompletion = executor
      .complete('main/work', { kind: 'completed', outcome: 'second-attempt-one' }, 1)
      .then(() => {
        secondCompleted = true;
      });

    const firstAttemptOne = executor.execute(requestForAttempt(1, 'a'), {
      signal: new AbortController().signal,
    });
    const attemptTwo = executor.execute(requestForAttempt(2, 'b'), {
      signal: new AbortController().signal,
    });

    await firstCompletion;
    await wait(0);
    expect(secondCompleted).toBe(false);
    await expect(firstAttemptOne).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'first-attempt-one',
    });

    await executor.complete('main/work', { kind: 'completed', outcome: 'attempt-two' }, 2);
    await expect(attemptTwo).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'attempt-two',
    });

    const nextAttemptOne = executor.execute(requestForAttempt(1, 'c'), {
      signal: new AbortController().signal,
    });
    await secondCompletion;
    await expect(nextAttemptOne).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'second-attempt-one',
    });
  });

  it('settles a claimed execution successfully when abort follows the claim', async () => {
    const executor = new ControlledRunExecutor();
    const controller = new AbortController();
    const execution = executor.execute(requestForAttempt(1, 'a'), {
      signal: controller.signal,
    });

    const completion = executor.complete('main/work', { kind: 'completed', outcome: 'claimed' }, 1);
    controller.abort(new Error('Abort arrived after the claim.'));

    await expect(completion).resolves.toBeUndefined();
    await expect(execution).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'claimed',
    });
  });

  it('waits for a new matching execution when abort wins before the claim', async () => {
    const executor = new ControlledRunExecutor();
    const controller = new AbortController();
    const abortedExecution = executor.execute(requestForAttempt(1, 'a'), {
      signal: controller.signal,
    });
    controller.abort(new Error('Abort won before the claim.'));

    await expect(abortedExecution).rejects.toThrow('Abort won before the claim.');
    let completionSettled = false;
    const completion = executor
      .complete('main/work', { kind: 'completed', outcome: 'replacement' }, 1)
      .then(() => {
        completionSettled = true;
      });
    const unrelatedExecution = executor.execute(requestForAttempt(2, 'b'), {
      signal: new AbortController().signal,
    });

    await wait(0);
    expect(completionSettled).toBe(false);
    await executor.complete('main/work', { kind: 'completed', outcome: 'unrelated' }, 2);
    await expect(unrelatedExecution).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'unrelated',
    });

    const replacementExecution = executor.execute(requestForAttempt(1, 'c'), {
      signal: new AbortController().signal,
    });
    await completion;
    await expect(replacementExecution).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'replacement',
    });
  });

  it('rejects a pre-aborted execution before it can be claimed', async () => {
    const executor = new ControlledRunExecutor();
    const controller = new AbortController();
    controller.abort(new Error('Signal was already aborted.'));
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
    const abortedExecution = executor.execute(requestForAttempt(1, 'a'), {
      signal: controller.signal,
    });
    let completionSettled = false;
    const completion = executor
      .complete('main/work', { kind: 'completed', outcome: 'replacement' }, 1)
      .then(() => {
        completionSettled = true;
      });

    await expect(abortedExecution).rejects.toThrow('Signal was already aborted.');
    await expect(executor.expectAborted('main/work')).resolves.toBeUndefined();
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));

    const unrelatedExecution = executor.execute(requestForAttempt(2, 'b'), {
      signal: new AbortController().signal,
    });
    await wait(0);
    expect(completionSettled).toBe(false);
    await executor.complete('main/work', { kind: 'completed', outcome: 'unrelated' }, 2);
    await expect(unrelatedExecution).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'unrelated',
    });

    const replacementExecution = executor.execute(requestForAttempt(1, 'c'), {
      signal: new AbortController().signal,
    });
    await completion;
    await expect(replacementExecution).resolves.toStrictEqual({
      kind: 'completed',
      outcome: 'replacement',
    });
  });
});
