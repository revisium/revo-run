import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const worker = new URL('../support/process/rn1-signal-recovery-worker.ts', import.meta.url)
  .pathname;

const hasWaitId = (value: object): value is { readonly waitId: string } => {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'waitId');
  return descriptor !== undefined && typeof descriptor.value === 'string';
};

const receiveMessage = async (child: ReturnType<typeof forkTestDbosProcess>): Promise<unknown> =>
  await new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const clean = (): void => {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stderr?.removeAllListeners('data');
    };
    const onMessage = (message: unknown): void => {
      clean();
      resolve(message);
    };
    const onError = (error: Error): void => {
      clean();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clean();
      reject(
        new Error(
          `RN1 recovery worker exited before its next message: ${code ?? signal ?? 'unknown'}: ${stderr}`,
        ),
      );
    };
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });

const waitFor = async (
  child: ReturnType<typeof forkTestDbosProcess>,
  kind: 'ready' | 'terminal',
): Promise<{ readonly kind: string; readonly waitId?: string }> => {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- IPC is the serialized worker protocol.
    const message = await receiveMessage(child);
    if (
      typeof message === 'object' &&
      message !== null &&
      'kind' in message &&
      message.kind === kind
    ) {
      return hasWaitId(message) ? { kind, waitId: message.waitId } : { kind };
    }
  }
};

const kill = async (child: ReturnType<typeof forkTestDbosProcess> | undefined): Promise<void> => {
  if (child?.killed !== false) {
    return;
  }
  child.kill('SIGKILL');
  await once(child, 'exit');
};

describe('RN1 fresh-process signal recovery', () => {
  let first: ReturnType<typeof forkTestDbosProcess> | undefined;
  let recovered: ReturnType<typeof forkTestDbosProcess> | undefined;

  afterEach(async () => {
    await kill(first);
    await kill(recovered);
  });

  it('continues one durable child signal operation after process death with the same wait identity', async () => {
    const runId = `rn1-recovery-${randomUUID()}`;
    const env = { RN1_TEST_DATABASE_URL: testDatabaseUrl(), RN1_TEST_RUN_ID: runId };
    const applicationVersion = `rn1-process-${randomUUID()}`;
    first = forkTestDbosProcess(worker, {
      applicationVersion,
      env: { ...env, RN1_TEST_MODE: 'start' },
    });
    const initial = await waitFor(first, 'ready');
    await kill(first);
    recovered = forkTestDbosProcess(worker, {
      applicationVersion,
      env: { ...env, RN1_TEST_MODE: 'recover' },
    });
    const resumed = await waitFor(recovered, 'ready');
    expect(resumed.waitId).toBe(initial.waitId);
    recovered.send({ kind: 'signal' });
    await expect(waitFor(recovered, 'terminal')).resolves.toEqual({ kind: 'terminal' });
  }, 30_000);
});
