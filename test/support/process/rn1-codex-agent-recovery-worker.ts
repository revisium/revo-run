import { readFile } from 'node:fs/promises';

import { RunManagerError } from '../../../src/contracts/run-manager-error.js';
import { loadAgentActiveInvocationSnapshots } from '../../../src/dbos/agent-active-invocation-registry.js';
import {
  createRunManager,
  type PipelineSourcePackage,
  type RunManager,
} from '../../../src/index.js';

const databaseUrl = process.env.RN1_TEST_DATABASE_URL;
const runId = process.env.RN1_TEST_RUN_ID;
const mode = process.env.RN1_TEST_MODE;
const workspace = process.env.RN1_TEST_WORKSPACE;
const callsPath = process.env.RN1_TEST_CALLS_PATH;

if (
  databaseUrl === undefined ||
  runId === undefined ||
  workspace === undefined ||
  callsPath === undefined ||
  (mode !== 'start' && mode !== 'recover')
) {
  throw new Error('RN1 Codex recovery worker has invalid input.');
}

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const resultSchema = {
  type: 'object' as const,
  properties: { ok: { type: 'boolean' as const } },
  required: ['ok'],
  additionalProperties: false as const,
};
const pipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-codex-active-recovery',
  entryModule: 'main',
  maximumTotalActivities: 1,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'codex',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'agent',
            id: 'codex',
            strategies: [
              { kind: 'single', routes: { succeeded: 'done', failed: 'done', cancelled: 'done' } },
            ],
            input: { prompt: { kind: 'literal', value: 'Wait for recovery.' } },
            inputSchema: {
              type: 'object',
              properties: { prompt: { type: 'string', enum: ['Wait for recovery.'] } },
              required: ['prompt'],
              additionalProperties: false,
            },
            outputSchema: resultSchema,
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const send = (kind: string, fields: Readonly<Record<string, unknown>> = {}): void => {
  process.send?.({ kind, ...fields });
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const manager: RunManager = createRunManager({
  database: { url: databaseUrl },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => ({ workspaceId: 'codex-recovery', repositoryId: 'fixture' }),
      acquire: async (_workspaceRef, context) => {
        if (context.signal.aborted) {
          throw new Error('Workspace acquisition aborted.');
        }
        return {
          workspaceId: 'codex-recovery',
          repositoryId: 'fixture',
          absolutePath: workspace,
        };
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Codex ambient auth must not acquire a host credential.');
      },
    },
  },
});

const invocationCall = async (): Promise<Readonly<{ pid: number }> | undefined> => {
  const text = await readFile(callsPath, 'utf8').catch(() => '');
  for (const line of text.trim().split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const value: unknown = JSON.parse(line);
    if (
      isRecord(value) &&
      Array.isArray(value.args) &&
      !(value.args.length === 1 && value.args[0] === '--version') &&
      typeof value.pid === 'number'
    ) {
      return { pid: value.pid };
    }
  }
  return undefined;
};

const waitForInvocation = async (): Promise<Readonly<{ pid: number }>> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- bounded process fixture polling observes the accepted child.
    const call = await invocationCall();
    if (call !== undefined) {
      return call;
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded process fixture polling delay.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Codex recovery worker did not observe an invocation: ${JSON.stringify(await manager.getRun(runId))}`,
  );
};

try {
  await manager.start();
  if (mode === 'start') {
    await manager.createRun({
      runId,
      pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {
          codex: {
            strategy: 'single',
            participant: { key: 'codex', bindingKey: 'codex' },
          },
        },
        bindings: {
          agents: {
            codex: {
              definition: { id: 'codex', version: 'definition-v1' },
              parameters: { model: 'test-model', allowAmbientLogin: true },
              permissions: { mode: 'read-only', network: false },
              workspaceRef: 'codex-recovery',
            },
          },
          scripts: {},
        },
      },
      input: {},
    });
    const call = await waitForInvocation();
    send('accepted', { pid: call.pid });
    await new Promise<void>(() => undefined);
  }
  const active = await loadAgentActiveInvocationSnapshots();
  send('initialized', { activeCount: active.length });
  try {
    const result = await manager.waitForTerminal(runId, { timeoutMs: 15_000 });
    send('terminal', { result });
  } catch (error) {
    if (!(error instanceof RunManagerError) || error.code !== 'run_recovery_required') {
      throw error;
    }
    send('terminal', { result: { snapshot: await manager.getRun(runId) } });
  }
  await manager.stop();
  process.exit(0);
} catch (error) {
  send('error', { message: error instanceof Error ? error.message : String(error) });
  await manager.stop().catch(() => undefined);
  process.exit(1);
}
