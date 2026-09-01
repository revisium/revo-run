import { isJsonValue } from '../../contracts/json.js';
import type { PreparedAgentBinding } from '../agent-port.js';

const environmentVariablePattern = /^[A-Za-z_]\w{0,127}$/u;
const logicalWorkspacePattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const configurationKeyPattern = /^[\s\S]{1,256}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const hasAllowedKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isDefinitionDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

const hasValidCredentials = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).length <= 123 &&
  Object.entries(value).every(
    ([environmentVariable, credential]) =>
      environmentVariablePattern.test(environmentVariable) &&
      isRecord(credential) &&
      hasExactKeys(credential, ['alias', 'environmentVariable']) &&
      credential.environmentVariable === environmentVariable &&
      isBoundedString(credential.alias, 256),
  );

const hasValidConfiguration = (value: unknown): boolean => {
  if (!isRecord(value) || !hasAllowedKeys(value, ['catalogRevision', 'selections'])) {
    return false;
  }
  if (
    !('selections' in value) ||
    (value.catalogRevision !== undefined && !isBoundedString(value.catalogRevision, 128)) ||
    !isRecord(value.selections) ||
    Object.keys(value.selections).length > 128
  ) {
    return false;
  }
  return Object.entries(value.selections).every(
    ([key, selection]) =>
      configurationKeyPattern.test(key) &&
      (typeof selection === 'boolean' ||
        (typeof selection === 'string' && selection.length <= 4_096)),
  );
};

/** Rejects incompatible nonterminal DBOS inputs before runtime recovery starts. */
export const isPreparedAgentBinding = (value: unknown): value is PreparedAgentBinding =>
  isRecord(value) &&
  isJsonValue(value) &&
  hasAllowedKeys(value, [
    'schemaVersion',
    'definition',
    'pin',
    'parameters',
    'permissions',
    'workspaceRef',
    'credentials',
    'configuration',
  ]) &&
  [
    'schemaVersion',
    'definition',
    'pin',
    'parameters',
    'permissions',
    'workspaceRef',
    'credentials',
  ].every((key) => key in value) &&
  value.schemaVersion === 'prepared-agent-binding/v1' &&
  isRecord(value.definition) &&
  hasExactKeys(value.definition, ['schemaVersion', 'value']) &&
  value.definition.schemaVersion === 'prepared-agent-definition-snapshot/v1' &&
  isRecord(value.definition.value) &&
  isRecord(value.pin) &&
  hasExactKeys(value.pin, ['agentId', 'agentVersion', 'definitionDigest']) &&
  isBoundedString(value.pin.agentId, 256) &&
  isBoundedString(value.pin.agentVersion, 256) &&
  isDefinitionDigest(value.pin.definitionDigest) &&
  isRecord(value.parameters) &&
  isRecord(value.permissions) &&
  typeof value.workspaceRef === 'string' &&
  logicalWorkspacePattern.test(value.workspaceRef) &&
  hasValidCredentials(value.credentials) &&
  (value.configuration === undefined || hasValidConfiguration(value.configuration));
