import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

type WorkerMessage = Readonly<{
  readonly kind: 'start' | 'accepted' | 'lookup' | 'terminal' | 'error';
  readonly invocationId?: string;
  readonly result?: {
    readonly snapshot?: { readonly status?: string };
    readonly details?: unknown;
  };
  readonly message?: string;
}>;

const workerPath = fileURLToPath(
  new URL('../support/process/rn1-private-agent-recovery-worker.ts', import.meta.url),
);

const startWorker = (runId: string, applicationVersion: string, mode: 'start' | 'recover') => {
  const process = forkTestDbosProcess(workerPath, {
    applicationVersion,
    env: {
      RN1_TEST_DATABASE_URL: testDatabaseUrl(),
      RN1_TEST_RUN_ID: runId,
      RN1_TEST_MODE: mode,
    },
  });
  const messages: WorkerMessage[] = [];
  process.on('message', (message: WorkerMessage) => messages.push(message));
  return { process, messages };
};

const waitFor = async (
  worker: ReturnType<typeof startWorker>,
  kind: WorkerMessage['kind'],
): Promise<WorkerMessage> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const error = worker.messages.find((message) => message.kind === 'error');
    if (error !== undefined) {
      throw new Error(error.message ?? 'Private agent worker failed.');
    }
    const message = worker.messages.find((candidate) => candidate.kind === kind);
    if (message !== undefined) {
      return message;
    }
    // oxlint-disable-next-line no-await-in-loop -- process recovery evidence uses bounded IPC polling.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Private agent worker did not emit ${kind}.`);
};

const kill = async (worker: ReturnType<typeof startWorker> | undefined): Promise<void> => {
  if (
    worker === undefined ||
    worker.process.killed ||
    worker.process.exitCode !== null ||
    worker.process.signalCode !== null
  ) {
    return;
  }
  worker.process.kill('SIGKILL');
  await once(worker.process, 'exit');
};

describe('RN1 private agent simulated recovery', () => {
  let first: ReturnType<typeof startWorker> | undefined;
  let recovered: ReturnType<typeof startWorker> | undefined;

  afterEach(async () => {
    await kill(first);
    await kill(recovered);
  });

  it('does not start a second invocation after a fresh-process recovery of the same durable operation', async () => {
    const runId = `rn1-private-agent-recovery-${randomUUID()}`;
    const applicationVersion = `rn1-private-agent-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start');
    const started = await waitFor(first, 'start');
    await expect(waitFor(first, 'accepted')).resolves.toMatchObject({ kind: 'accepted' });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    const lookup = await waitFor(recovered, 'lookup');
    const terminal = await waitFor(recovered, 'terminal');

    expect(lookup.invocationId).toBe(started.invocationId);
    expect(recovered.messages.filter(({ kind }) => kind === 'start')).toHaveLength(0);
    expect(terminal.result).toMatchObject({ snapshot: { status: 'recovery_required' } });
  }, 30_000);
});
