import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { codexContextCase } from '../support/codex-conformance.js';
import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

interface WorkerMessage {
  readonly kind: 'accepted' | 'initialized' | 'terminal' | 'error';
  readonly pid?: number;
  readonly activeCount?: number;
  readonly result?: unknown;
  readonly message?: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseCallArguments = (line: string): readonly string[] => {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    !Array.isArray(value.args) ||
    !value.args.every((item) => typeof item === 'string')
  ) {
    throw new Error('Fake Codex call has invalid arguments.');
  }
  return value.args;
};

const workerPath = fileURLToPath(
  new URL('../support/process/rn1-codex-agent-recovery-worker.ts', import.meta.url),
);

const fakeCodexSource = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const calls = join(dirname(fileURLToPath(import.meta.url)), 'calls.ndjson');
if (args.length === 1 && args[0] === '--version') {
  appendFileSync(calls, JSON.stringify({ args, pid: process.pid }) + '\\n');
  process.stdout.write('codex-cli 1.2.3\\n');
} else {
  const stdin = readFileSync(0);
  appendFileSync(calls, JSON.stringify({ args, pid: process.pid, stdin: stdin.toString('base64') }) + '\\n');
  setInterval(() => undefined, 1_000);
}
`;

const startWorker = (
  root: string,
  runId: string,
  applicationVersion: string,
  mode: 'start' | 'recover',
) => {
  const process = forkTestDbosProcess(workerPath, {
    applicationVersion,
    env: {
      RN1_TEST_DATABASE_URL: testDatabaseUrl(),
      RN1_TEST_RUN_ID: runId,
      RN1_TEST_MODE: mode,
      RN1_TEST_WORKSPACE: join(root, 'repository'),
      RN1_TEST_CALLS_PATH: join(root, 'bin', 'calls.ndjson'),
      PATH: join(root, 'bin'),
      HOME: join(root, 'ambient-home'),
      CODEX_HOME: join(root, 'ambient-codex-home'),
    },
  });
  const messages: WorkerMessage[] = [];
  const output: string[] = [];
  process.on('message', (message: WorkerMessage) => messages.push(message));
  process.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  process.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  return { process, messages, output };
};

const waitFor = async (
  worker: ReturnType<typeof startWorker>,
  kind: WorkerMessage['kind'],
): Promise<WorkerMessage> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const error = worker.messages.find((message) => message.kind === 'error');
    if (error !== undefined) {
      throw new Error(
        `${error.message ?? 'Codex recovery worker failed.'}\n${worker.output.join('')}`,
      );
    }
    const message = worker.messages.find((candidate) => candidate.kind === kind);
    if (message !== undefined) {
      return message;
    }
    if (worker.process.exitCode !== null || worker.process.signalCode !== null) {
      throw new Error(`Codex recovery worker exited before ${kind}.\n${worker.output.join('')}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded IPC polling is the process-test protocol.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex recovery worker did not emit ${kind}.`);
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

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('RN1 Codex active-process recovery', () => {
  let root: string | undefined;
  let first: ReturnType<typeof startWorker> | undefined;
  let recovered: ReturnType<typeof startWorker> | undefined;

  afterEach(async () => {
    await kill(first);
    await kill(recovered);
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CTX-ACTIVE-RECOVERY reaps registered identity before readiness without replay', async () => {
    const context = await codexContextCase('CTX-ACTIVE-RECOVERY');
    root = await mkdtemp(join(tmpdir(), 'revo-run-codex-recovery-'));
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'repository'));
    const binary = join(root, 'bin', 'codex');
    await writeFile(binary, fakeCodexSource);
    await chmod(binary, 0o755);
    const runId = `rn1-codex-recovery-${randomUUID()}`;
    const applicationVersion = `rn1-codex-recovery-${randomUUID()}`;

    first = startWorker(root, runId, applicationVersion, 'start');
    const accepted = await waitFor(first, 'accepted');
    if (accepted.pid === undefined) {
      throw new Error('Worker did not report the Codex PID.');
    }
    expect(isProcessRunning(accepted.pid)).toBe(true);
    await kill(first);

    recovered = startWorker(root, runId, applicationVersion, 'recover');
    const initialized = await waitFor(recovered, 'initialized');
    const processReaped = !isProcessRunning(accepted.pid);
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({
      result: { snapshot: { status: 'recovery_required' } },
    });

    const calls = (await readFile(join(root, 'bin', 'calls.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map(parseCallArguments);
    const invocationCalls = calls.filter(
      (args) => !(args.length === 1 && args[0] === '--version'),
    ).length;
    expect({
      loadedBeforeReadiness: initialized.activeCount === 0,
      processReaped,
      removeAcknowledged: initialized.activeCount === 0,
      invocationCalls,
      finalStatus:
        isRecord(terminal.result) && isRecord(terminal.result.snapshot)
          ? terminal.result.snapshot.status
          : null,
    }).toStrictEqual(context.expected);
  }, 40_000);
});
