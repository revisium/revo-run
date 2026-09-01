import type {
  AgentDefinitionInput,
  AgentManager,
  AgentManagerOptions,
} from '@revisium/revo-agent-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateRunManagerOptions } from '../../src/contracts/manager.js';
import { agentActiveInvocationStateSink } from '../../src/dbos/agent-active-invocation-registry.js';
import {
  bindingInput,
  createOptions,
  definition,
  descriptor,
  setup,
} from '../support/agent-runtime/revo-runtime-harness.js';

const runtime = vi.hoisted(() => ({
  createAgentManager: vi.fn<(options: AgentManagerOptions) => AgentManager>(),
  discoverAgents: vi.fn<
    () => Promise<{
      readonly definitions: readonly AgentDefinitionInput[];
      readonly diagnostics: readonly [];
      readonly modelObservations: readonly [];
    }>
  >(),
}));
vi.mock('@revisium/revo-agent-runtime', () => runtime);

afterEach(() => vi.clearAllMocks());

describe('generic agent-runtime binding', () => {
  it('discovers, initializes, binds, clones configuration, and wires the active-state sink', async () => {
    const { manager, port } = await setup(runtime);
    const prepared = await port.prepareBinding(bindingInput);
    await port.initialize([]);

    expect(runtime.discoverAgents).toHaveBeenCalledOnce();
    expect(manager.initialize).toHaveBeenCalledWith([]);
    const managerOptions = runtime.createAgentManager.mock.calls[0]?.[0];
    expect(managerOptions?.activeStateSink).toBe(agentActiveInvocationStateSink);
    expect(managerOptions?.definitions).toStrictEqual([definition]);
    expect(prepared).toMatchObject({
      pin: {
        agentId: definition.id,
        agentVersion: definition.version,
        definitionDigest: 'a'.repeat(64),
      },
      definition: { schemaVersion: 'prepared-agent-definition-snapshot/v1', value: definition },
      configuration: bindingInput.configuration,
    });
    expect(prepared.configuration).not.toBe(bindingInput.configuration);
    expect(prepared.configuration?.selections).not.toBe(bindingInput.configuration?.selections);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.configuration)).toBe(true);
    await port.shutdown();
  });

  it('rejects a changed discovered definition before acquiring workspace or credentials', async () => {
    const defaults = createOptions();
    const acquireWorkspace = vi.fn<CreateRunManagerOptions['host']['workspaces']['acquire']>(
      async (ref, context) => await defaults.host.workspaces.acquire(ref, context),
    );
    const acquireCredential = vi.fn<CreateRunManagerOptions['host']['credentials']['acquire']>(
      async (alias, context) => await defaults.host.credentials.acquire(alias, context),
    );
    const { manager, port } = await setup(
      runtime,
      createOptions({ acquireWorkspace, acquireCredential }),
    );
    const { credentials: _credentials, ...withoutCredentials } = bindingInput;
    const binding = await port.prepareBinding(withoutCredentials);
    manager.getAgent.mockReturnValue({ ...descriptor, definitionDigest: 'b'.repeat(64) });

    await expect(
      port.start({ invocationId: 'invocation-1', binding, prompt: 'test', result: { schema: {} } }),
    ).resolves.toStrictEqual({ status: 'unknown' });
    expect(acquireWorkspace).not.toHaveBeenCalled();
    expect(acquireCredential).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    await port.shutdown();
  });

  it('requires each unique credential alias to be discoverable before binding', async () => {
    const inspectCredential = vi.fn<CreateRunManagerOptions['host']['credentials']['inspect']>(
      async (alias) => (alias === 'missing' ? undefined : { alias, provider: 'test-provider' }),
    );
    const { port } = await setup(runtime, createOptions({ inspectCredential }));

    await expect(
      port.prepareBinding({
        ...bindingInput,
        credentials: { FIRST_TOKEN: 'primary', SECOND_TOKEN: 'missing', THIRD_TOKEN: 'primary' },
      }),
    ).rejects.toThrow('Credential alias is unavailable.');
    expect(inspectCredential).toHaveBeenCalledTimes(2);
    await port.shutdown();
  });
});
