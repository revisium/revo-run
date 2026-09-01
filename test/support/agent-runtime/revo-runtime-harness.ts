import type {
  AgentDefinitionInput,
  AgentDescriptor,
  AgentInvocationCancelled,
  AgentInvocationFailed,
  AgentInvocationSnapshot,
  AgentInvocationStatus,
  AgentInvocationSucceeded,
  AgentManager,
  AgentManagerOptions,
  AgentRef,
  AgentUsage,
} from '@revisium/revo-agent-runtime';
import { vi } from 'vitest';

import type {
  AgentBindingInput,
  AgentRuntimeStartInput,
  PreparedAgentBinding,
} from '../../../src/composition/agent-port.js';
import type { CreateRunManagerOptions } from '../../../src/contracts/manager.js';

export interface RuntimeMock {
  readonly createAgentManager: ReturnType<
    typeof vi.fn<(options: AgentManagerOptions) => AgentManager>
  >;
  readonly discoverAgents: ReturnType<typeof vi.fn>;
}

export const definition: AgentDefinitionInput = {
  schemaVersion: 'agent-definition/v1',
  id: 'test-agent',
  version: '1.0.0',
  displayName: 'Test agent',
  launch: {
    command: 'test-agent',
    args: [],
    versionProbe: { args: ['--version'], stream: 'stdout', timeoutMs: 1_000 },
  },
  protocol: {
    driver: 'native/stdio-v1',
    permissionStrategy: 'acp/v1',
  },
  delivery: { prompt: 'stdin', resultSchema: 'file', result: 'stdout' },
  parameters: { schema: {} },
  permissions: { schema: {} },
  capabilities: { cancellation: true, structuredResult: true, usage: true },
};

export const descriptor: AgentDescriptor = {
  agent: { id: definition.id, version: definition.version },
  definitionDigest: 'a'.repeat(64),
  displayName: definition.displayName,
  capabilities: definition.capabilities,
};

export const bindingInput: AgentBindingInput = {
  definition: { id: definition.id, version: definition.version },
  parameters: { temperature: 0 },
  permissions: { read: true },
  workspaceRef: 'test-workspace',
  credentials: { API_TOKEN: 'primary', SECONDARY_TOKEN: 'secondary' },
  configuration: {
    catalogRevision: 'b'.repeat(64),
    selections: { model: 'test-model', tracing: true },
  },
};

export const resultInput = (binding: PreparedAgentBinding): AgentRuntimeStartInput => ({
  invocationId: 'invocation-1',
  binding,
  prompt: 'Return a result.',
  result: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
});

export const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

export const lease = (alias: string, secret = `${alias}-secret`) => ({
  alias,
  provider: 'test-provider',
  secret,
  dispose: vi.fn<() => Promise<void>>(async () => undefined),
});

export const managerResult = (
  invocationId: string,
  pin: PreparedAgentBinding['pin'],
  value: unknown,
  usage?: AgentUsage,
): AgentInvocationSucceeded => ({
  schemaVersion: 'agent-invocation-result/v1',
  invocationId,
  pin,
  launch: { executable: 'test-agent', reportedVersion: '1.0.0' },
  acceptedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.001Z',
  durationMs: 1,
  exit: { code: 0, signal: null },
  files: {
    directory: '/output',
    events: 'events.ndjson',
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    result: 'result.json',
  },
  status: 'succeeded',
  value: { value },
  ...(usage === undefined ? {} : { usage }),
});

export const managerFailure = (
  invocationId: string,
  pin: PreparedAgentBinding['pin'],
  details: Readonly<Record<string, string>>,
): AgentInvocationFailed => ({
  schemaVersion: 'agent-invocation-result/v1',
  invocationId,
  pin,
  launch: { executable: 'test-agent', reportedVersion: '1.0.0' },
  acceptedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.001Z',
  durationMs: 1,
  exit: { code: 1, signal: null },
  files: {
    directory: '/output',
    events: 'events.ndjson',
    stdout: 'stdout.log',
    stderr: 'stderr.log',
  },
  status: 'failed',
  error: {
    code: 'revo.agent.internal',
    message: 'failed',
    phase: 'execution',
    retryable: false,
    details,
  },
});

export const managerCancelled = (
  invocationId: string,
  pin: PreparedAgentBinding['pin'],
): AgentInvocationCancelled => ({
  schemaVersion: 'agent-invocation-result/v1',
  invocationId,
  pin,
  launch: { executable: 'test-agent', reportedVersion: '1.0.0' },
  acceptedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.001Z',
  durationMs: 1,
  exit: { code: null, signal: 'SIGTERM' },
  files: {
    directory: '/output',
    events: 'events.ndjson',
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    result: 'result.json',
  },
  status: 'cancelled',
  error: {
    code: 'revo.agent.cancelled',
    message: 'cancelled',
    phase: 'running',
    retryable: false,
  },
});

export const managerSnapshot = (
  status: AgentInvocationStatus,
  pin: PreparedAgentBinding['pin'],
): AgentInvocationSnapshot => ({
  invocationId: 'invocation-1',
  pin,
  status,
  acceptedAt: '2026-01-01T00:00:00.000Z',
  outputDirectory: '/output',
});

export const createOptions = (overrides?: {
  readonly acquireWorkspace?: CreateRunManagerOptions['host']['workspaces']['acquire'];
  readonly inspectCredential?: CreateRunManagerOptions['host']['credentials']['inspect'];
  readonly acquireCredential?: CreateRunManagerOptions['host']['credentials']['acquire'];
}): CreateRunManagerOptions => ({
  database: { url: 'postgresql://example.invalid/test' },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => ({ workspaceId: 'workspace', repositoryId: 'repository' }),
      acquire:
        overrides?.acquireWorkspace ??
        (async () => ({
          workspaceId: 'workspace',
          repositoryId: 'repository',
          absolutePath: '/workspace',
        })),
    },
    credentials: {
      inspect:
        overrides?.inspectCredential ?? (async (alias) => ({ alias, provider: 'test-provider' })),
      acquire: overrides?.acquireCredential ?? (async (alias) => lease(alias)),
    },
  },
});

export const setup = async (runtime: RuntimeMock, options = createOptions()) => {
  const { createRevoAgentRuntimePort } =
    await import('../../../src/composition/agents/revo-runtime/revo-agent-runtime-port.js');
  const manager = {
    getAgent: vi.fn<AgentManager['getAgent']>((_agent: AgentRef) => descriptor),
    initialize: vi.fn<AgentManager['initialize']>(async () => undefined),
    start: vi.fn<AgentManager['start']>(async () => {
      throw new Error('Unexpected runtime start.');
    }),
    getResult: vi.fn<AgentManager['getResult']>(() => ({ state: 'unknown' as const })),
    cancel: vi.fn<AgentManager['cancel']>(async () => ({ state: 'unknown' as const })),
    shutdown: vi.fn<AgentManager['shutdown']>(async () => undefined),
    inspectConfiguration: vi.fn<AgentManager['inspectConfiguration']>(async () => {
      throw new Error('Configuration inspection is not used.');
    }),
    listAgents: vi.fn<AgentManager['listAgents']>(() => [descriptor]),
    getInvocation: vi.fn<AgentManager['getInvocation']>(() => undefined),
    listInvocations: vi.fn<AgentManager['listInvocations']>(() => []),
    waitForResult: vi.fn<AgentManager['waitForResult']>(async () => {
      throw new Error('Waiting is not used.');
    }),
    probeAgent: vi.fn<AgentManager['probeAgent']>(async () => {
      throw new Error('Probing is not used.');
    }),
    subscribe: vi.fn<AgentManager['subscribe']>(() => () => undefined),
  };
  runtime.discoverAgents.mockResolvedValue({
    definitions: [definition],
    diagnostics: [],
    modelObservations: [],
  });
  runtime.createAgentManager.mockReturnValue(manager);
  const port = await createRevoAgentRuntimePort(options);
  return { manager, port };
};
