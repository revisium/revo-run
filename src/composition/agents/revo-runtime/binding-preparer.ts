import type { AgentDefinitionInput, AgentManager } from '@revisium/revo-agent-runtime';

import { cloneFrozenJson, isJsonObject } from '../../../contracts/json.js';
import type { CreateRunManagerOptions } from '../../../contracts/manager.js';
import type {
  AgentBindingInput,
  PreparedAgentBinding,
  PreparedAgentDefinitionSnapshot,
} from '../../agent-port.js';

const definitionKey = (id: string, version: string): string => `${id}\u0000${version}`;

export const indexAgentDefinitions = (
  definitions: readonly AgentDefinitionInput[],
): ReadonlyMap<string, AgentDefinitionInput> =>
  new Map(
    definitions.map((definition) => [definitionKey(definition.id, definition.version), definition]),
  );

const cloneConfiguration = (configuration: AgentBindingInput['configuration']) =>
  configuration === undefined
    ? undefined
    : Object.freeze({
        ...(configuration.catalogRevision === undefined
          ? {}
          : { catalogRevision: configuration.catalogRevision }),
        selections: Object.freeze({ ...configuration.selections }),
      });

const snapshotDefinition = (definition: AgentDefinitionInput): PreparedAgentDefinitionSnapshot => {
  const value = structuredClone(definition);
  if (!isJsonObject(value)) {
    throw new Error('Agent definition is not portable JSON.');
  }
  return Object.freeze({
    schemaVersion: 'prepared-agent-definition-snapshot/v1',
    value: cloneFrozenJson(value),
  });
};

const inspectContext = { signal: new AbortController().signal };

export const createBindingPreparer =
  (
    definitions: ReadonlyMap<string, AgentDefinitionInput>,
    manager: Pick<AgentManager, 'getAgent'>,
    host: CreateRunManagerOptions['host'],
  ) =>
  async (input: AgentBindingInput): Promise<PreparedAgentBinding> => {
    const definition = definitions.get(
      definitionKey(input.definition.id, input.definition.version),
    );
    const descriptor = manager.getAgent(input.definition);
    if (definition === undefined || descriptor === undefined) {
      throw new Error('Agent definition is unavailable.');
    }
    if ((await host.workspaces.inspect(input.workspaceRef, inspectContext)) === undefined) {
      throw new Error('Workspace is unavailable.');
    }
    const credentials = input.credentials ?? {};
    const aliases = [...new Set(Object.values(credentials))];
    const inspectedCredentials = await Promise.all(
      aliases.map(async (alias) => await host.credentials.inspect(alias, inspectContext)),
    );
    if (inspectedCredentials.some((credential, index) => credential?.alias !== aliases[index])) {
      throw new Error('Credential alias is unavailable.');
    }
    const configuration = cloneConfiguration(input.configuration);
    return Object.freeze({
      schemaVersion: 'prepared-agent-binding/v1',
      definition: snapshotDefinition(definition),
      pin: Object.freeze({
        agentId: descriptor.agent.id,
        agentVersion: descriptor.agent.version,
        definitionDigest: descriptor.definitionDigest,
      }),
      parameters: cloneFrozenJson(input.parameters),
      permissions: cloneFrozenJson(input.permissions),
      workspaceRef: input.workspaceRef,
      credentials: Object.freeze(
        Object.fromEntries(
          Object.entries(credentials).map(([environmentVariable, alias]) => [
            environmentVariable,
            Object.freeze({ alias, environmentVariable }),
          ]),
        ),
      ),
      ...(configuration === undefined ? {} : { configuration }),
    });
  };
