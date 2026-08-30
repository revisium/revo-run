import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ActiveInvocationSnapshot,
  ActiveInvocationStateSink,
} from '@revisium/revo-agent-runtime';
import { vi, type Mock } from 'vitest';

import type {
  AgentBindingInput,
  AgentRuntimePort,
  PreparedAgentBinding,
} from '../../../src/composition/agent-port.js';
import { createCodexAgentRuntimePort } from '../../../src/composition/agents/codex/codex-agent-runtime-port.js';
import { CODEX_AGENT_REF } from '../../../src/composition/agents/codex/codex-definition.js';

export const codexResultSchema = {
  type: 'object' as const,
  properties: { ok: { type: 'boolean' as const } },
  required: ['ok'],
  additionalProperties: false as const,
};

export const codexBindingInput: AgentBindingInput = {
  definition: CODEX_AGENT_REF,
  parameters: { model: 'test-model', allowAmbientLogin: true },
  permissions: { mode: 'read-only', network: false },
  workspaceRef: 'disposable-workspace',
};

export type FakeCodexMode =
  | 'success'
  | 'success-with-secret'
  | 'malformed-result'
  | 'authentication-failure'
  | 'wait';

const fakeCodexSource = (version: string, mode: FakeCodexMode): string => `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const directory = dirname(fileURLToPath(import.meta.url));
if (args.length === 1 && args[0] === '--version') {
  appendFileSync(join(directory, 'calls.ndjson'), JSON.stringify({ args, pid: process.pid, environment: Object.keys(process.env).sort() }) + '\\n');
  process.stdout.write('codex-cli ${version}\\n');
} else {
  if (
    args[0] !== '--ask-for-approval=never' ||
    args[1] !== 'exec' ||
    args[2] !== '--ignore-user-config'
  ) {
    process.stderr.write('Usage: codex exec [OPTIONS] [PROMPT]\\n');
    process.exit(2);
  }
  const stdin = readFileSync(0);
  appendFileSync(
    join(directory, 'calls.ndjson'),
    JSON.stringify({
      args,
      pid: process.pid,
      environment: Object.keys(process.env).sort(),
      home: process.env.HOME,
      codexHome: process.env.CODEX_HOME,
      stdinBase64: stdin.toString('base64'),
    }) + '\\n',
  );
  JSON.parse(readFileSync(args[5], 'utf8'));
  const mode = '${mode}';
  if (mode === 'success' || mode === 'success-with-secret') {
    if (mode === 'success-with-secret') {
      process.stderr.write(String(process.env.HOME) + ':' + String(process.env.CODEX_HOME));
    }
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
  } else if (mode === 'malformed-result') {
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{bad}' } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
  } else if (mode === 'authentication-failure') {
    process.stderr.write('authentication unavailable');
    process.exitCode = 1;
  } else {
    setInterval(() => undefined, 1_000);
  }
}
`;

export interface FakeCodexCall {
  readonly args: readonly string[];
  readonly pid: number;
  readonly environment: readonly string[];
  readonly home?: string;
  readonly codexHome?: string;
  readonly stdinBase64?: string;
}

type AcquireWorkspace = (
  workspaceRef: string,
  context: Readonly<{ readonly signal: AbortSignal }>,
) => Promise<{
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly absolutePath: string;
}>;

export interface FakeCodexFixture {
  readonly root: string;
  readonly workspace: string;
  readonly callsPath: string;
  readonly home: string;
  readonly codexHome: string;
  readonly acquire: Mock<AcquireWorkspace>;
  readonly port: AgentRuntimePort;
}

export const createFakeCodexFixture = async (
  mode: FakeCodexMode,
  options: Readonly<{
    readonly version?: string;
    readonly installBinary?: boolean;
    readonly acquireMode?: 'immediate' | 'reject' | 'until-abort';
  }> = {},
): Promise<FakeCodexFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'revo-run-codex-port-'));
  const workspace = join(root, 'repository');
  const binaryDirectory = join(root, 'bin');
  const callsPath = join(binaryDirectory, 'calls.ndjson');
  const home = join(root, 'ambient-home-secret');
  const codexHome = join(root, 'ambient-codex-home-secret');
  await mkdir(workspace);
  await mkdir(binaryDirectory);
  if (options.installBinary !== false) {
    const binary = join(binaryDirectory, 'codex');
    await writeFile(binary, fakeCodexSource(options.version ?? '1.2.3', mode));
    await chmod(binary, 0o755);
  }
  vi.stubEnv('PATH', binaryDirectory);
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', codexHome);
  const acquire = vi.fn<AcquireWorkspace>(async (_workspaceRef, context) => {
    if (options.acquireMode === 'reject') {
      throw new Error('workspace unavailable');
    }
    if (options.acquireMode === 'until-abort') {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('acquire aborted')), {
          once: true,
        });
      });
    }
    return {
      workspaceId: 'disposable-workspace',
      repositoryId: 'fixture-repository',
      absolutePath: workspace,
    };
  });
  const active = new Map<string, ActiveInvocationSnapshot>();
  const activeStateSink: ActiveInvocationStateSink = {
    save: async (snapshot, context) => {
      if (context.signal.aborted) {
        throw new Error('aborted');
      }
      active.set(snapshot.invocationId, snapshot);
    },
    remove: async (invocationId, context) => {
      if (context.signal.aborted) {
        throw new Error('aborted');
      }
      active.delete(invocationId);
    },
  };
  const port = createCodexAgentRuntimePort(
    {
      inspect: async () => ({
        workspaceId: 'disposable-workspace',
        repositoryId: 'fixture-repository',
      }),
      acquire,
    },
    activeStateSink,
  );
  await port.initialize([]);
  return { root, workspace, callsPath, home, codexHome, acquire, port };
};

export const removeFakeCodexFixture = async (fixture: FakeCodexFixture): Promise<void> => {
  await fixture.port.shutdown('test_cleanup').catch(() => undefined);
  await rm(fixture.root, { recursive: true, force: true });
};

export const prepareCodexBinding = async (
  fixture: FakeCodexFixture,
  input: AgentBindingInput = codexBindingInput,
): Promise<PreparedAgentBinding> => await fixture.port.prepareBinding(input);

export const startFakeCodexOutcome = async (
  fixture: FakeCodexFixture,
  invocationId: string,
  limits?: Readonly<{ readonly wallClockTimeoutMs?: number; readonly idleTimeoutMs?: number }>,
) =>
  await fixture.port.start({
    invocationId,
    binding: await prepareCodexBinding(fixture),
    prompt: 'Return exact JSON.',
    metadata: { privatePath: '/must-not-be-durable' },
    result: { schema: codexResultSchema },
    ...(limits === undefined ? {} : { limits }),
  });

export const startFakeCodex = async (
  fixture: FakeCodexFixture,
  invocationId: string,
  limits?: Readonly<{ readonly wallClockTimeoutMs?: number; readonly idleTimeoutMs?: number }>,
) => {
  const outcome = await startFakeCodexOutcome(fixture, invocationId, limits);
  if (outcome.status !== 'accepted') {
    throw new Error(`Fake Codex start was ${outcome.status}.`);
  }
  return outcome.handle;
};

const isFakeCodexCall = (value: unknown): value is FakeCodexCall =>
  typeof value === 'object' &&
  value !== null &&
  'args' in value &&
  Array.isArray(value.args) &&
  value.args.every((argument) => typeof argument === 'string') &&
  'pid' in value &&
  typeof value.pid === 'number' &&
  'environment' in value &&
  Array.isArray(value.environment) &&
  value.environment.every((name) => typeof name === 'string');

export const readFakeCodexCalls = async (
  fixture: FakeCodexFixture,
): Promise<readonly FakeCodexCall[]> => {
  const values: unknown[] = (await readFile(fixture.callsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  if (!values.every(isFakeCodexCall)) {
    throw new Error('Fake Codex emitted an invalid call log.');
  }
  return values;
};

export const waitForFakeCodexCalls = async (
  fixture: FakeCodexFixture,
  count: number,
  remainingAttempts = 100,
): Promise<readonly FakeCodexCall[]> => {
  const observed = await readFakeCodexCalls(fixture).catch(() => []);
  if (observed.length >= count) {
    return observed;
  }
  if (remainingAttempts === 0) {
    throw new Error(`Fake Codex emitted only ${observed.length} call records.`);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return await waitForFakeCodexCalls(fixture, count, remainingAttempts - 1);
};

export const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
