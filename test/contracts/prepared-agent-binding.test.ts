import { describe, expect, it } from 'vitest';

import { isPreparedAgentBinding } from '../../src/composition/agents/prepared-agent-binding.js';

const binding = () => ({
  schemaVersion: 'prepared-agent-binding/v1',
  definition: {
    schemaVersion: 'prepared-agent-definition-snapshot/v1',
    value: { schemaVersion: 'agent-definition/v1', id: 'agent', version: '1' },
  },
  pin: {
    agentId: 'agent',
    agentVersion: '1',
    definitionDigest: 'a'.repeat(64),
  },
  parameters: {},
  permissions: {},
  workspaceRef: 'workspace-1',
  credentials: {
    API_TOKEN: { alias: 'primary', environmentVariable: 'API_TOKEN' },
  },
  configuration: {
    catalogRevision: 'revision-1',
    selections: { model: 'model-1', tracing: true },
  },
});

describe('prepared agent binding compatibility', () => {
  it('accepts the closed durable binding written by the generic adapter', () => {
    expect(isPreparedAgentBinding(binding())).toBe(true);
  });

  it.each([
    [
      'a non-object definition snapshot',
      { definition: { schemaVersion: 'prepared-agent-definition-snapshot/v1', value: [] } },
    ],
    ['a path-shaped workspace reference', { workspaceRef: '/private/workspace' }],
    [
      'an invalid credential environment variable',
      { credentials: { 'NOT-AN-ENV': { alias: 'primary', environmentVariable: 'NOT-AN-ENV' } } },
    ],
    [
      'a mismatched credential environment variable',
      { credentials: { API_TOKEN: { alias: 'primary', environmentVariable: 'OTHER_TOKEN' } } },
    ],
    [
      'too many credential bindings',
      {
        credentials: Object.fromEntries(
          Array.from({ length: 124 }, (_, index) => [
            `TOKEN_${index}`,
            { alias: `alias-${index}`, environmentVariable: `TOKEN_${index}` },
          ]),
        ),
      },
    ],
    [
      'too many configuration selections',
      {
        configuration: {
          selections: Object.fromEntries(
            Array.from({ length: 129 }, (_, index) => [`selection-${index}`, true]),
          ),
        },
      },
    ],
    [
      'an overlong configuration key',
      { configuration: { selections: { ['x'.repeat(257)]: true } } },
    ],
    ['an unknown configuration field', { configuration: { selections: {}, unexpected: true } }],
  ])('rejects %s before DBOS recovery', (_label, replacement) => {
    expect(isPreparedAgentBinding({ ...binding(), ...replacement })).toBe(false);
  });
});
