import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';

import { createRunManager, type RunSnapshot, type StartRunResult } from '../../src/index.js';
import type { ExecutionInvocation } from '../../src/types.js';

const mode = process.argv[2];
const directory = process.argv[3];
const databaseUrl = process.argv[4];
if (
  (mode !== 'first' && mode !== 'recover') ||
  directory === undefined ||
  databaseUrl === undefined
) {
  throw new Error('worker arguments are invalid');
}

const path = (name: string): string => join(directory, name);
const writeJson = async (file: string, value: unknown): Promise<void> => {
  const temporaryFile = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, JSON.stringify(value));
    await rename(temporaryFile, file);
  } catch (error: unknown) {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
};
const compilation = compilePipeline(
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
if (!compilation.ok) {
  throw new Error('worker execution plan is invalid');
}
const executionPlan = compilation.template;
const input = { value: 'durable input' };
const requestedRunId = 'caller-supplied/restart-run';

const readText = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const readAccepted = async (): Promise<StartRunResult> => {
  const source = await readFile(path('accepted.json'), 'utf8');
  const value: unknown = JSON.parse(source);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('runId' in value) ||
    typeof value.runId !== 'string'
  ) {
    throw new Error('accepted run is invalid');
  }
  return { runId: value.runId };
};

const manager = createRunManager({
  database: { url: databaseUrl },
  executor: {
    cancel: async () => ({ status: 'not_supported' }),
    reconcile: async (invocation) => {
      const recordedExecutionId = await readText(path('external-effect.json'));
      if (recordedExecutionId === undefined) {
        return { status: 'not_found' };
      }
      const value: unknown = JSON.parse(recordedExecutionId);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('executionId' in value) ||
        value.executionId !== invocation.executionId
      ) {
        return { status: 'outcome_unknown' };
      }
      return { status: 'completed', completion: { kind: 'task' } };
    },
    execute: async (invocation: ExecutionInvocation) => {
      const count = Number((await readText(path('executions.txt'))) ?? '0');
      await writeFile(path('executions.txt'), String(count + 1));
      await writeJson(path('external-effect.json'), { executionId: invocation.executionId });
      await writeFile(path('effect-recorded'), 'true');
      if (mode === 'first') {
        await new Promise<never>(() => undefined);
      }
      return { status: 'completed', completion: { kind: 'task' } } as const;
    },
  },
});

const waitForTerminal = async (runId: string): Promise<RunSnapshot> => {
  const deadline = Date.now() + 25_000;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- recovered DBOS status is polled sequentially
    const snapshot = await manager.getRun(runId);
    if (snapshot?.status === 'succeeded' || snapshot?.status === 'failed') {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for recovered run ${runId}.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- each recovery poll waits before retrying
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

await manager.start();
if (mode === 'first') {
  const accepted = await manager.startRun({ executionPlan, input, runId: requestedRunId });
  await writeJson(path('accepted.json'), accepted);
  await new Promise<never>(() => undefined);
}

const accepted = await readAccepted();
const final = await waitForTerminal(accepted.runId);
await writeJson(path('final.json'), final);
await manager.stop();
