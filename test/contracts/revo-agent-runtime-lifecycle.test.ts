import type {
  AgentDefinitionInput,
  AgentInvocationResult,
  AgentManager,
  AgentManagerOptions,
} from '@revisium/revo-agent-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateRunManagerOptions } from '../../src/contracts/manager.js';
import {
  bindingInput,
  createOptions,
  deferred,
  descriptor,
  lease,
  managerResult,
  resultInput,
  setup,
  type RuntimeMock,
} from '../support/agent-runtime/revo-runtime-harness.js';

const runtime = vi.hoisted(
  (): RuntimeMock => ({
    createAgentManager: vi.fn<(options: AgentManagerOptions) => AgentManager>(),
    discoverAgents: vi.fn<
      () => Promise<{
        readonly definitions: readonly AgentDefinitionInput[];
        readonly diagnostics: readonly [];
        readonly modelObservations: readonly [];
      }>
    >(),
  }),
);

vi.mock('@revisium/revo-agent-runtime', () => runtime);

const descriptorToPin = () => ({
  agentId: descriptor.agent.id,
  agentVersion: descriptor.agent.version,
  definitionDigest: descriptor.definitionDigest,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('generic agent-runtime adapter lifecycle', () => {
  it.each([
    [{ ok: true }, { ok: true }],
    ['scalar', 'scalar'],
  ])('maps object and scalar runtime result envelopes (%s)', async (runtimeValue, expected) => {
    const { manager, port } = await setup(runtime);
    const { credentials: _credentials, ...withoutCredentials } = bindingInput;
    const binding = await port.prepareBinding(withoutCredentials);
    manager.start.mockImplementation(async (input) => ({
      invocationId: input.invocationId,
      pin: descriptorToPin(),
      result: async () => managerResult(input.invocationId, descriptorToPin(), runtimeValue),
      cancel: async () => ({ state: 'unknown' as const }),
    }));
    const outcome = await port.start(resultInput(binding));
    if (outcome.status !== 'accepted') {
      throw new Error(`Expected accepted outcome, got ${outcome.status}.`);
    }
    await expect(outcome.handle.result()).resolves.toMatchObject({
      status: 'succeeded',
      value: expected,
    });
    await port.shutdown();
  });

  it('acquires a duplicate alias once and maps it to both environment variables', async () => {
    const owned = lease('shared');
    const acquireCredential = vi.fn<CreateRunManagerOptions['host']['credentials']['acquire']>(
      async () => owned,
    );
    const { manager, port } = await setup(runtime, createOptions({ acquireCredential }));
    const binding = await port.prepareBinding({
      ...bindingInput,
      credentials: { FIRST_TOKEN: 'shared', SECOND_TOKEN: 'shared' },
    });
    manager.start.mockImplementation(async (input) => ({
      invocationId: input.invocationId,
      pin: descriptorToPin(),
      result: async () => managerResult(input.invocationId, descriptorToPin(), 'ok'),
      cancel: async () => ({ state: 'unknown' as const }),
    }));
    const outcome = await port.start(resultInput(binding));
    if (outcome.status !== 'accepted') {
      throw new Error(`Expected accepted outcome, got ${outcome.status}.`);
    }
    expect(acquireCredential).toHaveBeenCalledOnce();
    expect(manager.start.mock.calls[0]?.[1]?.environment?.secrets).toStrictEqual({
      FIRST_TOKEN: 'shared-secret',
      SECOND_TOKEN: 'shared-secret',
    });
    await outcome.handle.result();
    await port.shutdown();
  });

  it('disposes every fulfilled lease when a peer credential acquisition fails', async () => {
    const primary = lease('primary');
    const secondaryError = new Error('secondary unavailable');
    const acquireCredential = vi.fn<CreateRunManagerOptions['host']['credentials']['acquire']>(
      async (alias) => {
        if (alias === 'secondary') {
          throw secondaryError;
        }
        return primary;
      },
    );
    const { port } = await setup(runtime, createOptions({ acquireCredential }));
    const binding = await port.prepareBinding(bindingInput);

    await expect(port.start(resultInput(binding))).rejects.toBe(secondaryError);
    expect(primary.dispose).toHaveBeenCalledOnce();
    await port.shutdown();
  });

  it('preserves acquisition and cleanup failures during partial credential acquisition', async () => {
    const primary = lease('primary');
    const cleanupError = new Error('primary cleanup failed');
    primary.dispose.mockRejectedValue(cleanupError);
    const acquisitionError = new Error('secondary unavailable');
    const acquireCredential = vi.fn<CreateRunManagerOptions['host']['credentials']['acquire']>(
      async (alias) => {
        if (alias === 'secondary') {
          throw acquisitionError;
        }
        return primary;
      },
    );
    const { port } = await setup(runtime, createOptions({ acquireCredential }));
    const binding = await port.prepareBinding(bindingInput);

    let thrown: unknown;
    try {
      await port.start(resultInput(binding));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) {
      throw new Error('Expected an aggregate acquisition error.');
    }
    expect(thrown.errors).toStrictEqual([acquisitionError, cleanupError]);
    expect(primary.dispose).toHaveBeenCalledOnce();
    await port.shutdown();
  });

  it('disposes a fulfilled lease whose returned alias does not match the request', async () => {
    const wrong = lease('wrong-alias');
    const { port } = await setup(runtime, createOptions({ acquireCredential: async () => wrong }));
    const binding = await port.prepareBinding({
      ...bindingInput,
      credentials: { API_TOKEN: 'requested-alias' },
    });

    await expect(port.start(resultInput(binding))).rejects.toThrow(
      'Credential resolver returned alias wrong-alias for requested-alias.',
    );
    expect(wrong.dispose).toHaveBeenCalledOnce();
    await port.shutdown();
  });

  it('retains leases until terminal result and releases them on shutdown', async () => {
    const owned = lease('primary');
    const acquireCredential = vi.fn<CreateRunManagerOptions['host']['credentials']['acquire']>(
      async () => owned,
    );
    const terminal = deferred<AgentInvocationResult>();
    const { manager, port } = await setup(runtime, createOptions({ acquireCredential }));
    const binding = await port.prepareBinding({
      ...bindingInput,
      credentials: { API_TOKEN: 'primary' },
    });
    manager.start.mockImplementation(async (input) => ({
      invocationId: input.invocationId,
      pin: descriptorToPin(),
      result: async () => terminal.promise,
      cancel: async () => ({ state: 'requested' as const }),
    }));

    const outcome = await port.start(resultInput(binding));
    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') {
      throw new Error(`Expected accepted outcome, got ${outcome.status}.`);
    }
    await expect(port.start(resultInput(binding))).resolves.toStrictEqual({ status: 'unknown' });
    expect(manager.start).toHaveBeenCalledOnce();
    expect(owned.dispose).not.toHaveBeenCalled();
    await port.shutdown('test shutdown');
    expect(owned.dispose).toHaveBeenCalledOnce();
    terminal.resolve(managerResult('invocation-1', descriptorToPin(), { ok: true }));
    await expect(outcome.handle.result()).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('surfaces manager and lease cleanup failures during shutdown', async () => {
    const owned = lease('primary');
    const cleanupError = new Error('lease cleanup failed');
    owned.dispose.mockRejectedValue(cleanupError);
    const managerError = new Error('manager shutdown failed');
    const terminal = deferred<AgentInvocationResult>();
    const { manager, port } = await setup(
      runtime,
      createOptions({ acquireCredential: async () => owned }),
    );
    const binding = await port.prepareBinding({
      ...bindingInput,
      credentials: { API_TOKEN: 'primary' },
    });
    manager.start.mockImplementation(async (input) => ({
      invocationId: input.invocationId,
      pin: descriptorToPin(),
      result: async () => terminal.promise,
      cancel: async () => ({ state: 'requested' as const }),
    }));
    const outcome = await port.start(resultInput(binding));
    expect(outcome.status).toBe('accepted');
    manager.shutdown.mockRejectedValue(managerError);

    await expect(port.shutdown()).rejects.toMatchObject({ errors: [managerError, cleanupError] });
    expect(owned.dispose).toHaveBeenCalledOnce();
  });

  it('does not publish a terminal result when background lease cleanup fails', async () => {
    const owned = lease('primary');
    const cleanupError = new Error('lease cleanup failed');
    owned.dispose.mockRejectedValue(cleanupError);
    const { manager, port } = await setup(
      runtime,
      createOptions({ acquireCredential: async () => owned }),
    );
    const binding = await port.prepareBinding({
      ...bindingInput,
      credentials: { API_TOKEN: 'primary' },
    });
    manager.start.mockImplementation(async (input) => ({
      invocationId: input.invocationId,
      pin: descriptorToPin(),
      result: async () => managerResult(input.invocationId, descriptorToPin(), 'ok'),
      cancel: async () => ({ state: 'unknown' as const }),
    }));
    const outcome = await port.start(resultInput(binding));
    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') {
      throw new Error(`Expected accepted outcome, got ${outcome.status}.`);
    }
    await expect(outcome.handle.result()).rejects.toBe(cleanupError);
    manager.getResult.mockReturnValue({
      state: 'completed',
      result: managerResult('invocation-1', descriptorToPin(), 'ok'),
    });
    expect(() => port.getResult('invocation-1')).toThrow(cleanupError);
    await expect(port.shutdown()).rejects.toBe(cleanupError);
  });

  it('aborts pending acquisition on cancel and does not start the runtime manager', async () => {
    const acquired =
      deferred<Awaited<ReturnType<CreateRunManagerOptions['host']['workspaces']['acquire']>>>();
    let observedSignal: AbortSignal | undefined;
    const acquireWorkspace = vi.fn<CreateRunManagerOptions['host']['workspaces']['acquire']>(
      async (_ref, context) => {
        observedSignal = context.signal;
        return await acquired.promise;
      },
    );
    const { manager, port } = await setup(runtime, createOptions({ acquireWorkspace }));
    const { credentials: _credentials, ...withoutCredentials } = bindingInput;
    const binding = await port.prepareBinding(withoutCredentials);
    const starting = port.start(resultInput(binding));
    await vi.waitFor(() => expect(acquireWorkspace).toHaveBeenCalledOnce());

    const cancellation = port.cancel('invocation-1', 'cancel before acceptance');
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    acquired.reject(new Error('workspace acquisition cancelled'));

    await expect(cancellation).resolves.toStrictEqual({ state: 'unknown' });
    await expect(starting).resolves.toStrictEqual({ status: 'unknown' });
    expect(manager.start).not.toHaveBeenCalled();
    await port.shutdown();
  });
});
