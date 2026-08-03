import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';

import { createRunManager, type RunSnapshot } from '../../src/index.js';
import { parseRunSnapshot } from './parse-run-snapshot.js';

const mode = process.argv[2];
const directory = process.argv[3];
const databaseUrl = process.argv[4];
if (
  (mode !== 'first' && mode !== 'recover') ||
  directory === undefined ||
  databaseUrl === undefined
)
  throw new Error('worker arguments are invalid');

const path = (name: string): string => join(directory, name);
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
if (!compilation.ok) throw new Error('worker pipeline is invalid');

const readSnapshot = async (): Promise<RunSnapshot | undefined> => {
  try {
    return parseRunSnapshot(await readFile(path('snapshot.json'), 'utf8'));
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};
const persist = async (snapshot: RunSnapshot): Promise<void> => {
  await writeFile(path('snapshot.json'), JSON.stringify(snapshot));
};
const manager = createRunManager({
  database: { url: databaseUrl },
  plans: { loadExact: async () => ({ compiledPipeline: compilation.pipeline }) },
  executor: {
    execute: async () => {
      let count = 0;
      try {
        count = Number(await readFile(path('executions.txt'), 'utf8'));
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await writeFile(path('executions.txt'), String(count + 1));
      return { outcome: 'completed' };
    },
  },
  snapshots: {
    create: persist,
    get: async () => readSnapshot(),
    update: async (snapshot) => {
      if (snapshot.status === 'succeeded') {
        await writeFile(path('terminal-reached'), 'true');
        if (mode === 'first') await new Promise<never>(() => undefined);
      }
      await persist(snapshot);
    },
  },
});

const terminalDeadline = Date.now() + 25_000;
const waitForTerminal = async (): Promise<void> => {
  const snapshot = await readSnapshot();
  if (snapshot?.status === 'succeeded') return;
  if (Date.now() >= terminalDeadline)
    throw new Error(`Timed out waiting for recovered terminal snapshot in ${directory}.`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForTerminal();
};

await manager.start();
if (mode === 'first') {
  const accepted = await manager.startRun({
    planPin: { id: 'plan', revision: '1', digest: 'digest' },
    input: { value: 'input' },
  });
  await writeFile(path('accepted.json'), JSON.stringify(accepted));
}
await waitForTerminal();
await manager.stop();
