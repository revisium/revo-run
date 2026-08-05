import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { compilePipeline, definePipeline, type JsonValue } from '@revisium/revo-pipeline';

import { createRunManager, type RunSnapshot, type StartRunResult } from '../../src/index.js';
import type { ExecutionInvocation } from '../../src/types.js';

const mode = process.argv[2];
const scenario = process.argv[3];
const directory = process.argv[4];
const databaseUrl = process.argv[5];
if (
  (mode !== 'first' && mode !== 'recover' && mode !== 'inspect') ||
  (scenario !== 'pre-checkpoint' && scenario !== 'post-checkpoint') ||
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
const compilation =
  scenario === 'pre-checkpoint' ? preCheckpointCompilation : postCheckpointCompilation;
if (!compilation.ok) {
  throw new Error('worker execution plan is invalid');
}
const executionPlan = compilation.template;
const input = { scenario, value: 'durable input' };
const requestedRunId = `caller-supplied/restart-run-${scenario}`;

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

const readJson = async (file: string): Promise<unknown> => {
  const source = await readText(file);
  return source === undefined ? undefined : (JSON.parse(source) as unknown);
};

const readAccepted = async (): Promise<StartRunResult> => {
  const value = await readJson(path('accepted.json'));
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

interface EffectRecord {
  readonly executionId: string;
  readonly output: JsonValue;
}

const isEffectRecord = (value: unknown): value is EffectRecord =>
  typeof value === 'object' &&
  value !== null &&
  'executionId' in value &&
  typeof value.executionId === 'string' &&
  'output' in value;

const isEffectMap = (value: unknown): value is Record<string, EffectRecord> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(isEffectRecord);

const isExecutionCounts = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (count: unknown) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
  );

const incrementCount = async (file: string, nodeKey: string): Promise<void> => {
  const value = await readJson(path(file));
  const counts = isExecutionCounts(value) ? value : {};
  counts[nodeKey] = (counts[nodeKey] ?? 0) + 1;
  await writeJson(path(file), counts);
};

const readEffects = async (): Promise<Record<string, EffectRecord>> => {
  const value = await readJson(path('external-effects.json'));
  if (value === undefined) {
    return {};
  }
  if (!isEffectMap(value)) {
    throw new Error('external effects are invalid');
  }
  return value;
};

const recordExecution = async (invocation: ExecutionInvocation): Promise<EffectRecord> => {
  await incrementCount('executions.json', invocation.nodeKey);

  const output = {
    executionId: invocation.executionId,
    sequence: invocation.nodeKey === 'first' ? 1 : invocation.nodeKey === 'second' ? 2 : 0,
  };
  const effect = { executionId: invocation.executionId, output };
  const effects = await readEffects();
  effects[invocation.nodeKey] = effect;
  await writeJson(path('external-effects.json'), effects);
  return effect;
};

const manager = createRunManager({
  database: { url: databaseUrl },
  executor: {
    cancel: async () => ({ status: 'not_supported' }),
    reconcile: async (invocation) => {
      await incrementCount('reconciliation-callbacks.json', invocation.nodeKey);
      const effect = (await readEffects())[invocation.nodeKey];
      if (effect === undefined) {
        return { status: 'not_found' };
      }
      if (effect.executionId !== invocation.executionId) {
        return { status: 'outcome_unknown' };
      }
      return { status: 'completed', completion: { kind: 'task', output: effect.output } };
    },
    execute: async (invocation: ExecutionInvocation) => {
      const effect = await recordExecution(invocation);
      const shouldInterrupt =
        mode === 'first' &&
        ((scenario === 'pre-checkpoint' && invocation.nodeKey === 'task') ||
          (scenario === 'post-checkpoint' && invocation.nodeKey === 'second'));
      if (shouldInterrupt) {
        await writeFile(path('interruption-ready'), 'true');
        await new Promise<never>(() => undefined);
      }
      return { status: 'completed', completion: { kind: 'task', output: effect.output } } as const;
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
await writeJson(path(mode === 'inspect' ? 'inspected.json' : 'final.json'), final);
await manager.stop();
