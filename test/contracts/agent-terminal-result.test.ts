import { describe, expect, it } from 'vitest';

import { isAgentTerminalResult } from '../../src/composition/agent-terminal-result.js';

const pin = {
  agentId: 'agent',
  agentVersion: '1',
  definitionDigest: 'a'.repeat(64),
};

const succeeded = () => ({
  schemaVersion: 'agent-terminal-result/v1',
  invocationId: 'invocation-1',
  pin,
  status: 'succeeded',
  value: 'complete',
});

describe('durable agent terminal result', () => {
  it('accepts scalar success and closed non-negative usage', () => {
    expect(
      isAgentTerminalResult({
        ...succeeded(),
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }),
    ).toBe(true);
  });

  it.each([
    ['an explicit undefined usage value', { usage: { inputTokens: undefined } }],
    ['a negative usage value', { usage: { inputTokens: -1 } }],
    ['an unknown usage field', { usage: { cachedInputTokens: 1 } }],
    ['an invalid definition digest', { pin: { ...pin, definitionDigest: 'sha256:invalid' } }],
  ])('rejects %s', (_label, replacement) => {
    expect(isAgentTerminalResult({ ...succeeded(), ...replacement })).toBe(false);
  });

  it('accepts only object-shaped failure details', () => {
    const failure = {
      schemaVersion: 'agent-terminal-result/v1',
      invocationId: 'invocation-1',
      pin,
      status: 'failed',
      error: { code: 'provider_failed', message: 'failed', details: { provider: 'test' } },
    };
    expect(isAgentTerminalResult(failure)).toBe(true);
    expect(
      isAgentTerminalResult({ ...failure, error: { ...failure.error, details: ['invalid'] } }),
    ).toBe(false);
  });
});
