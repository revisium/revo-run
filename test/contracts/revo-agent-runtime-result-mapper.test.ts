import { describe, expect, it } from 'vitest';

import {
  mapCancel,
  mapLookup,
  mapResult,
  runtimeResultSchema,
} from '../../src/composition/agents/revo-runtime/result-mapper.js';
import {
  descriptor,
  managerCancelled,
  managerFailure,
  managerResult,
  managerSnapshot,
} from '../support/agent-runtime/revo-runtime-harness.js';

const pin = {
  agentId: descriptor.agent.id,
  agentVersion: descriptor.agent.version,
  definitionDigest: descriptor.definitionDigest,
};

describe('generic runtime result mapping', () => {
  it('wraps the pipeline result schema in the runtime object envelope', () => {
    const schema = { type: 'string' };
    expect(runtimeResultSchema(schema)).toStrictEqual({
      type: 'object',
      properties: { value: schema },
      required: ['value'],
      additionalProperties: false,
    });
  });

  it('rejects a successful runtime result outside the required envelope', () => {
    expect(() =>
      mapResult({ ...managerResult('invocation-1', pin, 'unused'), value: { unexpected: true } }),
    ).toThrow('Agent runtime returned an invalid result envelope.');
  });

  it('copies failure details and normalizes usage into closed owned objects', () => {
    const details = { providerCode: 'unavailable' };
    const mappedFailure = mapResult(managerFailure('invocation-1', pin, details));
    if (mappedFailure.status !== 'failed' && mappedFailure.status !== 'timed_out') {
      throw new Error(`Expected failure result, got ${mappedFailure.status}.`);
    }
    expect(mappedFailure).toMatchObject({
      status: 'failed',
      error: {
        code: 'revo.agent.internal',
        message: 'failed',
        phase: 'execution',
        retryable: false,
        details,
      },
    });
    expect(mappedFailure.error.details).not.toBe(details);

    const usage = { inputTokens: 1, totalTokens: 2, extra: 3 };
    const mappedSuccess = mapResult(managerResult('invocation-1', pin, 'ok', usage));
    if (mappedSuccess.status !== 'succeeded') {
      throw new Error(`Expected success result, got ${mappedSuccess.status}.`);
    }
    expect(mappedSuccess.usage).toStrictEqual({ inputTokens: 1, totalTokens: 2 });
    expect(mappedSuccess.usage).not.toBe(usage);
  });

  it.each(['accepted', 'starting', 'running', 'cancelling'] as const)(
    'preserves the active %s lookup',
    (status) => {
      expect(mapLookup({ state: 'running', invocation: managerSnapshot(status, pin) })).toEqual({
        state: 'running',
        invocation: { invocationId: 'invocation-1', pin, status },
      });
    },
  );

  it.each(['succeeded', 'failed', 'cancelled', 'timed_out'] as const)(
    'fails closed for an inconsistent running lookup with %s status',
    (status) => {
      expect(mapLookup({ state: 'running', invocation: managerSnapshot(status, pin) })).toEqual({
        state: 'unknown',
      });
    },
  );

  it('maps unknown, completed, and already-completed cancellation outcomes', () => {
    const result = managerCancelled('invocation-1', pin);
    expect(mapLookup({ state: 'unknown' })).toStrictEqual({ state: 'unknown' });
    expect(mapLookup({ state: 'completed', result })).toMatchObject({
      state: 'completed',
      result: { status: 'cancelled' },
    });
    expect(mapCancel({ state: 'already_completed', result })).toMatchObject({
      state: 'already_completed',
      result: { status: 'cancelled' },
    });
    expect(mapCancel({ state: 'requested' })).toStrictEqual({ state: 'requested' });
  });
});
