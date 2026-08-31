import type { AgentDefinitionInput } from '@revisium/revo-agent-runtime';
import { Type } from 'typebox';

export const CODEX_AGENT_REF = Object.freeze({ id: 'codex', version: 'definition-v1' });

const codexParametersJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    model: { type: 'string', minLength: 1, maxLength: 128 },
    allowAmbientLogin: { const: true },
  },
  required: ['model', 'allowAmbientLogin'],
  additionalProperties: false,
} as const;

const codexPermissionsJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    mode: { enum: ['read-only', 'workspace-write'] },
    network: { type: 'boolean' },
  },
  required: ['mode', 'network'],
  additionalProperties: false,
} as const;

export const CodexParametersSchema = Type.Unsafe(codexParametersJsonSchema);
export const CodexPermissionsSchema = Type.Unsafe(codexPermissionsJsonSchema);

export const CODEX_AGENT_DEFINITION = Object.freeze({
  schemaVersion: 'agent-definition/v1',
  id: CODEX_AGENT_REF.id,
  version: CODEX_AGENT_REF.version,
  displayName: 'Codex CLI',
  launch: {
    command: 'codex',
    args: [
      { kind: 'literal', value: '--ask-for-approval=never' },
      { kind: 'literal', value: 'exec' },
      { kind: 'literal', value: '--ignore-user-config' },
      { kind: 'literal', value: '--json' },
      { kind: 'literal', value: '--output-schema' },
      { kind: 'result-schema-file' },
      { kind: 'permission', name: 'mode' },
      { kind: 'permission', name: 'network' },
      { kind: 'literal', value: '--model' },
      { kind: 'parameter', name: 'model' },
      { kind: 'literal', value: '--' },
      { kind: 'literal', value: '-' },
    ],
    versionProbe: {
      args: ['--version'],
      stream: 'stdout',
      prefix: 'codex-cli ',
      timeoutMs: 5_000,
    },
  },
  protocol: {
    driver: 'native/stdio-v1',
    resultParser: 'codex-jsonl/v1',
    permissionStrategy: 'codex-cli/v1',
  },
  delivery: { prompt: 'stdin', resultSchema: 'file', result: 'stdout' },
  parameters: { schema: codexParametersJsonSchema },
  permissions: { schema: codexPermissionsJsonSchema },
  capabilities: { cancellation: true, structuredResult: true, usage: true },
  constraints: { platforms: ['linux'] },
} as const satisfies AgentDefinitionInput);
