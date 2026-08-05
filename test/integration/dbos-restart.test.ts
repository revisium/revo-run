import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { describe, expect, it } from 'vitest';

import { assertIsolatedTestDatabase } from '../support/test-database.js';

const databaseUrl = process.env['DATABASE_URL'];
const integration = databaseUrl === undefined ? describe.skip : describe;
const waitForFile = async (file: string, deadline = Date.now() + 20_000): Promise<string> => {
  while (true) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- subprocess readiness is polled sequentially
      return await readFile(file, 'utf8');
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for integration file ${file}.`, { cause: error });
      }
      // oxlint-disable-next-line no-await-in-loop -- each readiness attempt waits before retrying
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
};
const waitForExit = (child: ChildProcess, deadline = Date.now() + 20_000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        reject(new Error(`Timed out waiting for restart worker ${String(child.pid)} to exit.`));
      },
      Math.max(0, deadline - Date.now()),
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || signal === 'SIGKILL') {
        resolve();
      } else {
        reject(new Error(`restart worker exited with ${String(code)} (${String(signal)})`));
      }
    });
  });
};
const terminate = async (child: ChildProcess | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGKILL');
  await waitForExit(child);
};
const worker = join(import.meta.dirname, '../support/dbos-restart-worker.ts');
type Scenario = 'pre-checkpoint' | 'post-checkpoint';
const launchWorker = (
  mode: 'first' | 'recover' | 'inspect',
  scenario: Scenario,
  directory: string,
  connectionUrl: string,
) =>
  spawn(process.execPath, ['--import', 'tsx', worker, mode, scenario, directory, connectionUrl], {
    stdio: 'inherit',
  });

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, 'utf8')) as unknown;

const parseAccepted = (source: string): { readonly runId: string } => {
  const value: unknown = JSON.parse(source);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('runId' in value) ||
    typeof value.runId !== 'string'
  ) {
    throw new Error('Accepted run result is invalid.');
  }
  return { runId: value.runId };
};

const preCheckpointCompilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'task',
    facts: [],
    nodes: [
      {
        kind: 'task',
        key: 'task',
        outcomes: { completed: 'done', failed: 'failed', cancelled: 'failed', skipped: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'succeeded' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);
const postCheckpointCompilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'first',
    facts: [],
    nodes: [
      {
        kind: 'task',
        key: 'first',
        outcomes: { completed: 'second', failed: 'failed', cancelled: 'failed', skipped: 'failed' },
      },
      {
        kind: 'task',
        key: 'second',
        outcomes: { completed: 'done', failed: 'failed', cancelled: 'failed', skipped: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'published' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);
if (!preCheckpointCompilation.ok || !postCheckpointCompilation.ok) {
  throw new Error('integration execution plans are invalid');
}

integration('DBOS-authoritative restart and replay', () => {
  it.each([
    {
      expectedCallbacks: { task: 2 },
      expectedCounts: { task: 1 },
      expectedOutcome: 'succeeded',
      expectedOutputs: [{ nodeKey: 'task', value: { sequence: 0 } }],
      plan: preCheckpointCompilation.template,
      scenario: 'pre-checkpoint' as const,
      title: 'adopts an external result interrupted before its first DBOS checkpoint',
    },
    {
      expectedCallbacks: { first: 1, second: 2 },
      expectedCounts: { first: 1, second: 1 },
      expectedOutcome: 'published',
      expectedOutputs: [
        { nodeKey: 'first', value: { sequence: 1 } },
        { nodeKey: 'second', value: { sequence: 2 } },
      ],
      plan: postCheckpointCompilation.template,
      scenario: 'post-checkpoint' as const,
      title: 'replays a checkpointed first output after interruption before terminal completion',
    },
  ])(
    '$title',
    async ({
      expectedCallbacks,
      expectedCounts,
      expectedOutcome,
      expectedOutputs,
      plan,
      scenario,
    }) => {
      if (databaseUrl === undefined) {
        throw new Error('DATABASE_URL is required.');
      }
      assertIsolatedTestDatabase(databaseUrl);
      const directory = await mkdtemp(join(tmpdir(), `revo-run-restart-${scenario}-`));
      let first: ChildProcess | undefined;
      let recovered: ChildProcess | undefined;
      let inspector: ChildProcess | undefined;
      try {
        first = launchWorker('first', scenario, directory, databaseUrl);
        const acceptedSource = await waitForFile(join(directory, 'accepted.json'));
        await waitForFile(join(directory, 'interruption-ready'));
        const accepted = parseAccepted(acceptedSource);
        const runId = accepted.runId;
        expect(runId).toBe(`caller-supplied/restart-run-${scenario}`);

        first.kill('SIGKILL');
        await waitForExit(first);

        recovered = launchWorker('recover', scenario, directory, databaseUrl);
        await waitForExit(recovered);

        const final = await readJson(join(directory, 'final.json'));
        expect(final).toMatchObject({
          executionPlan: plan,
          id: runId,
          input: { scenario, value: 'durable input' },
          result: { outcome: expectedOutcome, outputs: expectedOutputs },
          status: 'succeeded',
        });
        const executionsAfterRecovery = await readJson(join(directory, 'executions.json'));
        const callbacksAfterRecovery = await readJson(
          join(directory, 'reconciliation-callbacks.json'),
        );
        expect(executionsAfterRecovery).toEqual(expectedCounts);
        expect(callbacksAfterRecovery).toEqual(expectedCallbacks);

        inspector = launchWorker('inspect', scenario, directory, databaseUrl);
        await waitForExit(inspector);

        expect(await readJson(join(directory, 'inspected.json'))).toEqual(final);
        expect(await readJson(join(directory, 'executions.json'))).toEqual(executionsAfterRecovery);
        expect(await readJson(join(directory, 'reconciliation-callbacks.json'))).toEqual(
          callbacksAfterRecovery,
        );
      } finally {
        await terminate(first);
        await terminate(recovered);
        await terminate(inspector);
        await rm(directory, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
