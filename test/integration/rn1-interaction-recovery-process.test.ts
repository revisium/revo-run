import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type { KernelRunResult } from '../../src/dbos/kernel-run-workflow.js';
import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';
import {
  assertRecoveryObservation,
  recoveryExpectedString,
  recoveryScenario,
} from '../support/rn1-recovery-matrix.js';
import { testDatabaseUrl } from '../support/test-environment.js';

type Interaction = 'duration' | 'gate' | 'parallel';
type ReadyMessage = Readonly<{
  readonly kind: 'ready';
  readonly waitIds?: readonly string[];
  readonly gateId?: string;
  readonly eventTypes?: readonly string[];
}>;

const workerPath = fileURLToPath(
  new URL('../support/process/rn1-interaction-recovery-worker.ts', import.meta.url),
);

const startWorker = (
  runId: string,
  applicationVersion: string,
  mode: 'start' | 'recover',
  operation: Interaction,
) =>
  forkTestDbosProcess(workerPath, {
    applicationVersion,
    env: {
      RN1_TEST_DATABASE_URL: testDatabaseUrl(),
      RN1_TEST_RUN_ID: runId,
      RN1_TEST_MODE: mode,
      RN1_TEST_INTERACTION: operation,
    },
  });

const nextMessage = async (
  worker: ReturnType<typeof startWorker>,
): Promise<
  Readonly<{
    readonly kind?: string;
    readonly waitIds?: readonly string[];
    readonly gateId?: string;
    readonly eventTypes?: readonly string[];
  }>
> =>
  await new Promise((resolve, reject) => {
    let stderr = '';
    const clean = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      worker.stderr?.removeListener('data', onStderr);
    };
    const onMessage = (message: unknown): void => {
      clean();
      if (typeof message === 'object' && message !== null) {
        resolve(message);
        return;
      }
      reject(new Error('Interaction worker emitted a non-object message.'));
    };
    const onError = (error: Error): void => {
      clean();
      reject(error);
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clean();
      reject(
        new Error(
          `Interaction worker exited before its next message: ${code ?? signal ?? 'unknown'}: ${stderr}`,
        ),
      );
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.stderr?.on('data', onStderr);
  });

function waitFor(worker: ReturnType<typeof startWorker>, kind: 'ready'): Promise<ReadyMessage>;
function waitFor(
  worker: ReturnType<typeof startWorker>,
  kind: 'terminal',
): Promise<Readonly<{ readonly kind: 'terminal' }>>;
async function waitFor(
  worker: ReturnType<typeof startWorker>,
  kind: 'ready' | 'terminal',
): Promise<ReadyMessage | Readonly<{ readonly kind: 'terminal' }>> {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- IPC messages are the serialized worker protocol.
    const message = await nextMessage(worker);
    if (message.kind === kind) {
      return kind === 'ready'
        ? {
            kind,
            ...(message.waitIds === undefined ? {} : { waitIds: message.waitIds }),
            ...(message.gateId === undefined ? {} : { gateId: message.gateId }),
            ...(message.eventTypes === undefined ? {} : { eventTypes: message.eventTypes }),
          }
        : { kind };
    }
  }
}

const kill = async (worker: ReturnType<typeof startWorker> | undefined): Promise<void> => {
  if (
    worker === undefined ||
    worker.killed ||
    worker.exitCode !== null ||
    worker.signalCode !== null
  ) {
    return;
  }
  worker.kill('SIGKILL');
  await once(worker, 'exit');
};

describe('RN1 fresh-process interaction recovery', () => {
  let first: ReturnType<typeof startWorker> | undefined;
  let recovered: ReturnType<typeof startWorker> | undefined;

  afterEach(async () => {
    await kill(first);
    await kill(recovered);
  });

  it('preserves a duration wait across a fresh process and lets its original timer settle', async () => {
    const runId = `rn1-duration-recovery-${randomUUID()}`;
    const applicationVersion = `rn1-duration-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', 'duration');
    const initial = await waitFor(first, 'ready');
    expect(initial).toMatchObject({ waitIds: [expect.any(String)] });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover', 'duration');
    const resumed = await waitFor(recovered, 'ready');
    expect(resumed).toStrictEqual(initial);
    await expect(waitFor(recovered, 'terminal')).resolves.toStrictEqual({ kind: 'terminal' });
  }, 30_000);

  it('preserves a human-gate identity across a fresh process before one authorized answer settles it', async () => {
    const runId = `rn1-gate-recovery-${randomUUID()}`;
    const applicationVersion = `rn1-gate-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', 'gate');
    const initial = await waitFor(first, 'ready');
    expect(typeof initial.gateId).toBe('string');
    expect(initial.gateId?.length).toBeGreaterThan(0);
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover', 'gate');
    const resumed = await waitFor(recovered, 'ready');
    expect(resumed).toStrictEqual(initial);
    recovered.send({ kind: 'settle' });
    await expect(waitFor(recovered, 'terminal')).resolves.toStrictEqual({ kind: 'terminal' });
  }, 30_000);

  it('preserves both concurrent parallel wait identities across a fresh process before they settle', async () => {
    const scenario = recoveryScenario('D6');
    const runId = `rn1-parallel-recovery-${randomUUID()}`;
    const applicationVersion = `rn1-parallel-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', 'parallel');
    const initial = await waitFor(first, 'ready');
    expect(initial.waitIds).toHaveLength(2);
    DBOS.setConfig({
      name: `revo-run-d6-observation-${randomUUID()}`,
      systemDatabaseUrl: testDatabaseUrl(),
    });
    await DBOS.launch();
    try {
      const details = await DBOS.getEvent<KernelRunResult['details']>(
        runWorkflowId(runId),
        'revo-run.details',
      );
      expect(details).toMatchObject({
        status: recoveryExpectedString(scenario, 'status'),
        terminal: null,
        operations: [
          expect.objectContaining({ kind: 'signalWait', status: 'running' }),
          expect.objectContaining({ kind: 'signalWait', status: 'running' }),
        ],
      });
      assertRecoveryObservation(scenario, {
        state: details?.terminal === null ? 'pending' : 'terminal',
        status: details?.status ?? 'absent',
        events: {
          script: initial.eventTypes?.filter((type) => type === 'script.event').length ?? 0,
          kernel: initial.eventTypes?.filter((type) => type === 'run.terminal').length ?? 0,
        },
        calls: {
          execute: details?.attempts.length ?? 0,
          reconcile:
            initial.eventTypes?.filter((type) => type === 'activity.recovery_required').length ?? 0,
          cancel:
            initial.eventTypes?.filter((type) => type === 'run.cancellation_acknowledged').length ??
            0,
        },
        prohibited: {
          duplicateInteraction:
            initial.waitIds === undefined ||
            new Set(initial.waitIds).size !== initial.waitIds.length,
          newAttempt: (details?.attempts.length ?? 0) > 0,
        },
      });
    } finally {
      await DBOS.shutdown();
    }
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover', 'parallel');
    const resumed = await waitFor(recovered, 'ready');
    expect(resumed).toStrictEqual(initial);
    recovered.send({ kind: 'settle' });
    await expect(waitFor(recovered, 'terminal')).resolves.toStrictEqual({ kind: 'terminal' });
  }, 30_000);
});
