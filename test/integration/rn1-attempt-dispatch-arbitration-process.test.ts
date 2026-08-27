import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attemptDispatchArbitrationIdentityToken,
  attemptDispatchArbitrationWorkflowId,
  attemptId,
  operationId,
} from '../../src/operations/identities.js';
import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

interface WorkerMessage {
  readonly kind:
    | 'arbitration-body-entered'
    | 'arbitration-body-executed'
    | 'error'
    | 'ready'
    | 'result';
  readonly message?: string;
  readonly result?: unknown;
}

const winnerFromResult = (value: unknown): 'dispatch_won' | 'cancel_won' => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('winner' in value) ||
    (value.winner !== 'dispatch_won' && value.winner !== 'cancel_won')
  ) {
    throw new Error('Expected a strict arbitration result.');
  }
  return value.winner;
};

const workerPath = fileURLToPath(
  new URL('../support/process/rn1-attempt-arbitration-worker.ts', import.meta.url),
);

const startWorker = (
  applicationVersion: string,
  parentWorkflowId: string,
  executionId: string,
  currentAttemptId: string,
  winner: 'dispatch_won' | 'cancel_won',
  options: Readonly<{
    readonly pauseAtArbitrationBodyEntry?: boolean;
    readonly waitForParentRelease?: boolean;
  }> = {},
) => {
  const process = forkTestDbosProcess(workerPath, {
    applicationVersion,
    env: {
      RN1_TEST_DATABASE_URL: testDatabaseUrl(),
      RN1_TEST_PARENT_WORKFLOW_ID: parentWorkflowId,
      RN1_TEST_EXECUTION_ID: executionId,
      RN1_TEST_ATTEMPT_ID: currentAttemptId,
      RN1_TEST_WINNER: winner,
      ...(options.pauseAtArbitrationBodyEntry
        ? { RN1_TEST_PAUSE_AT_ARBITRATION_BODY_ENTRY: '1' }
        : {}),
      ...(options.waitForParentRelease ? { RN1_TEST_WAIT_FOR_PARENT_RELEASE: '1' } : {}),
    },
  });
  const messages: WorkerMessage[] = [];
  process.on('message', (message: WorkerMessage) => messages.push(message));
  return { messages, process };
};

const waitForResult = async (child: ReturnType<typeof startWorker>): Promise<unknown> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const error = child.messages.find((message) => message.kind === 'error');
    if (error !== undefined) {
      throw new Error(error.message ?? 'Arbitration worker failed.');
    }
    const result = child.messages.find((message) => message.kind === 'result');
    if (result !== undefined) {
      return result.result;
    }
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error('Arbitration worker exited without a result.');
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded IPC polling is the process-test protocol.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Arbitration worker did not return a result.');
};

const waitForArbitrationBodyEntry = async (
  child: ReturnType<typeof startWorker>,
): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const error = child.messages.find((message) => message.kind === 'error');
    if (error !== undefined) {
      throw new Error(error.message ?? 'Arbitration worker failed.');
    }
    if (child.messages.some((message) => message.kind === 'arbitration-body-entered')) {
      return;
    }
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(
        'Arbitration worker exited before entering the intercepted arbitration body.',
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded IPC polling is the process-test protocol.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Arbitration worker did not enter the intercepted arbitration body.');
};

const waitForExecutorReady = async (child: ReturnType<typeof startWorker>): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const error = child.messages.find((message) => message.kind === 'error');
    if (error !== undefined) {
      throw new Error(error.message ?? 'Arbitration worker failed.');
    }
    if (child.messages.some((message) => message.kind === 'ready')) {
      return;
    }
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error('Arbitration worker exited before its DBOS executor was ready.');
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded IPC polling is the process-test protocol.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Arbitration worker did not report a ready DBOS executor.');
};

const releaseContenders = (...children: ReturnType<typeof startWorker>[]): void => {
  for (const child of children) {
    child.process.send({ kind: 'release' });
  }
};

const stop = async (child: ReturnType<typeof startWorker> | undefined): Promise<void> => {
  if (
    child === undefined ||
    child.process.killed ||
    child.process.exitCode !== null ||
    child.process.signalCode !== null
  ) {
    return;
  }
  child.process.kill('SIGKILL');
  await once(child.process, 'exit');
};

describe('RN1 attempt arbitration across fresh DBOS executors', () => {
  let dispatch: ReturnType<typeof startWorker> | undefined;
  let cancel: ReturnType<typeof startWorker> | undefined;
  let replay: ReturnType<typeof startWorker> | undefined;
  let interrupted: ReturnType<typeof startWorker> | undefined;
  let recovered: ReturnType<typeof startWorker> | undefined;

  afterEach(async () => {
    await stop(dispatch);
    await stop(cancel);
    await stop(replay);
    await stop(interrupted);
    await stop(recovered);
  });

  it('keeps one first durable winner and zero-step history across fresh contenders and root GC', async () => {
    const suffix = randomUUID();
    const applicationVersion = `rn1-arbitration-${suffix}`;
    const executionId = operationId(`rn1-arbitration-${suffix}`, 'command');
    const currentAttemptId = attemptId(executionId, 1);
    const gateWorkflowId = attemptDispatchArbitrationWorkflowId(executionId, currentAttemptId);

    dispatch = startWorker(
      applicationVersion,
      `rn1-arbitration-parent-dispatch-${suffix}`,
      executionId,
      currentAttemptId,
      'dispatch_won',
      { waitForParentRelease: true },
    );
    await waitForExecutorReady(dispatch);
    cancel = startWorker(
      applicationVersion,
      `rn1-arbitration-parent-cancel-${suffix}`,
      executionId,
      currentAttemptId,
      'cancel_won',
      { waitForParentRelease: true },
    );
    await waitForExecutorReady(cancel);
    releaseContenders(dispatch, cancel);
    const [dispatchResult, cancelResult] = await Promise.all([
      waitForResult(dispatch),
      waitForResult(cancel),
    ]);
    expect(dispatchResult).toStrictEqual(cancelResult);
    expect(dispatchResult).toMatchObject({
      schemaVersion: 'attempt-dispatch-arbitration/v1',
      executionId,
      attemptId: currentAttemptId,
      identityToken: attemptDispatchArbitrationIdentityToken(executionId, currentAttemptId),
    });

    replay = startWorker(
      applicationVersion,
      `rn1-arbitration-parent-replay-${suffix}`,
      executionId,
      currentAttemptId,
      'dispatch_won',
    );
    await expect(waitForResult(replay)).resolves.toStrictEqual(dispatchResult);

    DBOS.setConfig({
      name: `revo-run-rn1-arbitration-inspection-${suffix}`,
      systemDatabaseUrl: testDatabaseUrl(),
    });
    await DBOS.launch();
    try {
      const gate = DBOS.retrieveWorkflow(gateWorkflowId);
      const [storedInput] = await gate.getWorkflowInputs<[unknown]>();
      expect(storedInput).toStrictEqual(dispatchResult);
      await expect(gate.getResult()).resolves.toStrictEqual(dispatchResult);
      await expect(DBOS.listWorkflowSteps(gateWorkflowId)).resolves.toStrictEqual([]);

      const winningParentId =
        winnerFromResult(dispatchResult) === 'dispatch_won'
          ? `rn1-arbitration-parent-dispatch-${suffix}`
          : `rn1-arbitration-parent-cancel-${suffix}`;
      await DBOS.deleteWorkflow(winningParentId, true);
      await expect(DBOS.getWorkflowStatus(gateWorkflowId)).resolves.toBeNull();
    } finally {
      await DBOS.shutdown();
    }
  }, 30_000);

  it.each(['dispatch_won', 'cancel_won'] as const)(
    'recovers an intercepted %s production arbitration-body crash with exactly one actual body execution',
    async (firstWinner) => {
      const suffix = randomUUID();
      const applicationVersion = `rn1-arbitration-entry-crash-${suffix}`;
      const executionId = operationId(`rn1-arbitration-entry-crash-${suffix}`, 'command');
      const currentAttemptId = attemptId(executionId, 1);
      const parentWorkflowId = `rn1-arbitration-entry-crash-parent-${suffix}`;
      const gateWorkflowId = attemptDispatchArbitrationWorkflowId(executionId, currentAttemptId);

      interrupted = startWorker(
        applicationVersion,
        parentWorkflowId,
        executionId,
        currentAttemptId,
        firstWinner,
        { pauseAtArbitrationBodyEntry: true },
      );
      await waitForArbitrationBodyEntry(interrupted);
      interrupted.process.kill('SIGKILL');
      await once(interrupted.process, 'exit');
      expect(
        interrupted.messages.filter((message) => message.kind === 'arbitration-body-entered'),
      ).toHaveLength(1);
      expect(
        interrupted.messages.filter((message) => message.kind === 'arbitration-body-executed'),
      ).toHaveLength(0);
      expect(interrupted.messages.filter((message) => message.kind === 'result')).toHaveLength(0);

      recovered = startWorker(
        applicationVersion,
        parentWorkflowId,
        executionId,
        currentAttemptId,
        firstWinner,
        { waitForParentRelease: true },
      );
      await waitForExecutorReady(recovered);
      replay = startWorker(
        applicationVersion,
        `rn1-arbitration-entry-crash-contender-${suffix}`,
        executionId,
        currentAttemptId,
        firstWinner,
        { waitForParentRelease: true },
      );
      await waitForExecutorReady(replay);
      releaseContenders(recovered, replay);
      const [result, contenderResult] = await Promise.all([
        waitForResult(recovered),
        waitForResult(replay),
      ]);
      expect(result).toStrictEqual({
        schemaVersion: 'attempt-dispatch-arbitration/v1',
        executionId,
        attemptId: currentAttemptId,
        identityToken: attemptDispatchArbitrationIdentityToken(executionId, currentAttemptId),
        winner: firstWinner,
      });
      expect(contenderResult).toStrictEqual(result);
      expect(recovered.messages.filter((message) => message.kind === 'result')).toHaveLength(1);
      // DBOS re-enters the registered wrapper after the killed process.  The
      // interruption is intentionally before `body.apply`, so exactly one
      // production inner-body execution is possible; a post-inner-body crash
      // must be replayed by DBOS and cannot honestly prove that property.
      expect(
        [interrupted, recovered, replay].flatMap((child) =>
          child?.messages.filter((message) => message.kind === 'arbitration-body-entered'),
        ),
      ).toHaveLength(2);
      expect(
        [interrupted, recovered, replay].flatMap((child) =>
          child?.messages.filter((message) => message.kind === 'arbitration-body-executed'),
        ),
      ).toHaveLength(1);

      DBOS.setConfig({
        name: `revo-run-rn1-arbitration-entry-crash-inspection-${suffix}`,
        systemDatabaseUrl: testDatabaseUrl(),
      });
      await DBOS.launch();
      try {
        const gate = DBOS.retrieveWorkflow(gateWorkflowId);
        await expect(gate.getWorkflowInputs()).resolves.toStrictEqual([result]);
        await expect(gate.getResult()).resolves.toStrictEqual(result);
        await expect(DBOS.listWorkflowSteps(gateWorkflowId)).resolves.toStrictEqual([]);
        await expect(DBOS.getWorkflowStatus(gateWorkflowId)).resolves.toMatchObject({
          status: 'SUCCESS',
          workflowName: 'revo-run.attempt-dispatch-arbitration/v1',
        });
      } finally {
        await DBOS.shutdown();
      }
    },
    30_000,
  );

  it.each([
    ['dispatch_won', 'cancel_won'],
    ['cancel_won', 'dispatch_won'],
  ] as const)(
    'persists a forced first %s winner before the later %s contender arrives',
    async (firstWinner, laterWinner) => {
      const suffix = randomUUID();
      const applicationVersion = `rn1-arbitration-forced-${suffix}`;
      const executionId = operationId(`rn1-arbitration-forced-${suffix}`, 'command');
      const currentAttemptId = attemptId(executionId, 1);

      dispatch = startWorker(
        applicationVersion,
        `rn1-arbitration-forced-first-${suffix}`,
        executionId,
        currentAttemptId,
        firstWinner,
      );
      const firstResult = await waitForResult(dispatch);
      expect(winnerFromResult(firstResult)).toBe(firstWinner);

      cancel = startWorker(
        applicationVersion,
        `rn1-arbitration-forced-later-${suffix}`,
        executionId,
        currentAttemptId,
        laterWinner,
      );
      await expect(waitForResult(cancel)).resolves.toStrictEqual(firstResult);

      DBOS.setConfig({
        name: `revo-run-rn1-arbitration-forced-inspection-${suffix}`,
        systemDatabaseUrl: testDatabaseUrl(),
      });
      await DBOS.launch();
      try {
        const gate = DBOS.retrieveWorkflow(
          attemptDispatchArbitrationWorkflowId(executionId, currentAttemptId),
        );
        await expect(gate.getWorkflowInputs()).resolves.toStrictEqual([firstResult]);
        await expect(gate.getResult()).resolves.toStrictEqual(firstResult);
        await expect(DBOS.listWorkflowSteps(gate.workflowID)).resolves.toStrictEqual([]);
      } finally {
        await DBOS.shutdown();
      }
    },
    30_000,
  );
});
