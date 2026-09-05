import type {
  AgentManager,
  AgentInvocationResult,
  AgentResultLookup,
} from '@revisium/revo-agent-runtime';

import { cloneFrozenJson, isJsonObject, isJsonValue } from '../../../contracts/json.js';
import type {
  AgentResultLookup as LocalLookup,
  AgentTerminalResult,
  CancelInvocationResult,
} from '../../agent-port.js';

const mapPin = (pin: AgentInvocationResult['pin']) =>
  Object.freeze({
    agentId: pin.agentId,
    agentVersion: pin.agentVersion,
    definitionDigest: pin.definitionDigest,
  });

const mapUsage = (usage: NonNullable<AgentInvocationResult['usage']>) => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
});

const mapDetails = (details: unknown) => {
  if (!isJsonObject(details)) {
    throw new Error('Agent runtime returned invalid failure details.');
  }
  return cloneFrozenJson(details);
};

export const runtimeResultSchema = (schema: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties: { value: schema },
  required: ['value'],
  additionalProperties: false,
});

const unwrapResult = (value: unknown) => {
  if (!isJsonObject(value) || Object.keys(value).length !== 1 || !isJsonValue(value.value)) {
    throw new Error('Agent runtime returned an invalid result envelope.');
  }
  return cloneFrozenJson(value.value);
};

export const mapResult = (result: AgentInvocationResult): AgentTerminalResult => {
  const base = {
    schemaVersion: 'agent-terminal-result/v1' as const,
    invocationId: result.invocationId,
    pin: mapPin(result.pin),
  };
  if (result.status === 'succeeded') {
    return {
      ...base,
      status: 'succeeded',
      value: unwrapResult(result.value),
      ...(result.usage === undefined ? {} : { usage: mapUsage(result.usage) }),
    };
  }
  if (result.status === 'cancelled') {
    return { ...base, status: 'cancelled' };
  }
  return {
    ...base,
    status: result.status === 'timed_out' ? 'timed_out' : 'failed',
    error: {
      code: result.error.code,
      message: result.error.message,
      ...(result.error.phase === undefined ? {} : { phase: result.error.phase }),
      ...(result.error.retryable === undefined ? {} : { retryable: result.error.retryable }),
      ...(result.error.details === undefined ? {} : { details: mapDetails(result.error.details) }),
    },
  };
};

export const mapLookup = (lookup: AgentResultLookup): LocalLookup => {
  if (lookup.state === 'unknown') {
    return { state: 'unknown' };
  }
  if (lookup.state === 'completed') {
    return { state: 'completed', result: mapResult(lookup.result) };
  }
  const status = lookup.invocation.status;
  if (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed_out'
  ) {
    return { state: 'unknown' };
  }
  return {
    state: 'running',
    invocation: {
      invocationId: lookup.invocation.invocationId,
      pin: mapPin(lookup.invocation.pin),
      status,
    },
  };
};

export const mapCancel = (
  value: Awaited<ReturnType<AgentManager['cancel']>>,
): CancelInvocationResult =>
  value.state === 'already_completed'
    ? { state: value.state, result: mapResult(value.result) }
    : value;
