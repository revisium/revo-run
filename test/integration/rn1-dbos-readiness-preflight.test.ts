import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

interface WorkerMessage {
  readonly kind: 'dispatch' | 'error' | 'launched' | 'started' | 'terminal';
  readonly message?: string;
  readonly result?: unknown;
}

const waitFor = async (
  messages: readonly WorkerMessage[],
  expected: WorkerMessage['kind'],
  timeoutMs = 10_000,
): Promise<WorkerMessage> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = messages.find(({ kind }) => kind === expected);
    if (message !== undefined) {
      return message;
    }
    const error = messages.find(({ kind }) => kind === 'error');
    if (error !== undefined) {
      throw new Error(`Readiness worker failed: ${error.message ?? 'unknown error'}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded polling verifies the recovery fence.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Readiness worker did not emit ${expected}.`);
};

const startWorker = (mode: 'recover' | 'start', workflowId: string, applicationVersion: string) => {
  const worker = fileURLToPath(
    new URL('../support/process/rn1-readiness-preflight-worker.ts', import.meta.url),
  );
  const process = forkTestDbosProcess(worker, {
    applicationVersion,
    env: {
      REVO_RUN_RN1_PREFLIGHT_DATABASE_URL: testDatabaseUrl(),
      REVO_RUN_RN1_PREFLIGHT_MODE: mode,
      REVO_RUN_RN1_PREFLIGHT_WORKFLOW_ID: workflowId,
    },
  });
  const exited = once(process, 'exit');
  const messages: WorkerMessage[] = [];
  process.on('message', (message: WorkerMessage) => messages.push(message));
  return { exited, messages, process };
};

describe('RN1 DBOS recovery readiness preflight', () => {
  it('returns from launch with recovery fenced and dispatches exactly once after readiness opens', async () => {
    const suffix = randomUUID();
    const workflowId = `rn1-readiness-${suffix}`;
    const applicationVersion = `revo-run-rn1-preflight-${suffix}`;
    const first = startWorker('start', workflowId, applicationVersion);
    let recovered: ReturnType<typeof startWorker> | undefined;

    try {
      await waitFor(first.messages, 'launched');
      await waitFor(first.messages, 'started');
      await waitFor(first.messages, 'dispatch');
      first.process.kill('SIGKILL');
      await first.exited;

      recovered = startWorker('recover', workflowId, applicationVersion);
      await waitFor(recovered.messages, 'launched');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(recovered.messages.filter(({ kind }) => kind === 'dispatch')).toHaveLength(0);

      recovered.process.send({ kind: 'open' });
      await expect(waitFor(recovered.messages, 'terminal')).resolves.toMatchObject({
        result: { status: 'dispatched' },
      });
      expect(recovered.messages.filter(({ kind }) => kind === 'dispatch')).toHaveLength(1);
      await recovered.exited;
    } finally {
      first.process.kill('SIGKILL');
      recovered?.process.kill('SIGKILL');
      await Promise.all([first.exited, ...(recovered === undefined ? [] : [recovered.exited])]);
    }
  }, 30_000);
});
