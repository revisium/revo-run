import type {
  AgentInvocationHandle as RuntimeInvocationHandle,
  AgentInvocationResult as RuntimeInvocationResult,
  AgentResultLookup as RuntimeResultLookup,
  CancelInvocationResult as RuntimeCancelResult,
} from '@revisium/revo-agent-runtime';

import {
  cloneFrozenJson,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../../../contracts/json.js';
import type {
  AgentInvocationHandle,
  AgentResultLookup,
  AgentTerminalFailure,
  AgentTerminalResult,
  CancelInvocationResult,
} from '../../agent-port.js';
import { containsUnsafeTerminalPathToken } from './codex-terminal-text.js';

const bounded = (value: string, maximum: number, fallback: string): string =>
  value.length > 0 && value.length <= maximum ? value : fallback;

const genericFailure = Object.freeze({
  code: 'revo.run.execution_failed',
  message: 'Agent execution failed.',
});

const forbiddenKeySegments = new Set([
  'auth',
  'authentication',
  'authorization',
  'credential',
  'credentials',
  'env',
  'environment',
  'key',
  'keys',
  'password',
  'secret',
  'secrets',
  'token',
]);

const forbiddenJoinedKeySuffixes = Object.freeze([
  'auth',
  'authentication',
  'authorization',
  'credential',
  'credentials',
  'environment',
  'password',
  'secret',
  'secrets',
  'token',
  'tokens',
]);

const forbiddenJoinedKeyInfixes = Object.freeze(['accesskey', 'apikey', 'privatekey', 'secretkey']);

const keySegments = (key: string): readonly string[] =>
  key
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);

const isForbiddenKey = (key: string): boolean => {
  const segments = keySegments(key);
  const joined = segments.join('');
  return (
    segments.some((segment) => forbiddenKeySegments.has(segment)) ||
    forbiddenJoinedKeySuffixes.some((suffix) => joined.endsWith(suffix)) ||
    forbiddenJoinedKeyInfixes.some((infix) => joined.includes(infix))
  );
};

const containsCapturedSecret = (value: string, secretValues: readonly string[]): boolean =>
  secretValues.some((secret) => secret.length > 0 && value.includes(secret));

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const isSafeTerminalJson = (value: JsonValue, secretValues: readonly string[]): boolean => {
  if (typeof value === 'string') {
    return !containsUnsafeTerminalPathToken(value) && !containsCapturedSecret(value, secretValues);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return true;
  }
  if (isJsonArray(value)) {
    return value.every((item) => isSafeTerminalJson(item, secretValues));
  }
  return Object.entries(value).every(
    ([key, item]) => !isForbiddenKey(key) && isSafeTerminalJson(item, secretValues),
  );
};

const safeSuccessValue = (
  value: unknown,
  secretValues: readonly string[],
): JsonObject | undefined =>
  isJsonObject(value) && isSafeTerminalJson(value, secretValues)
    ? cloneFrozenJson(value)
    : undefined;

const sanitizeFailure = (
  result: RuntimeInvocationResult,
  secretValues: readonly string[],
): AgentTerminalFailure => {
  if (result.status === 'succeeded') {
    throw new Error('Agent success has no failure value.');
  }
  const code = bounded(result.error.code, 256, genericFailure.code);
  const message = bounded(result.error.message, 4_096, genericFailure.message);
  return isSafeTerminalJson({ code, message }, secretValues)
    ? Object.freeze({ code, message })
    : genericFailure;
};

export const sanitizeAgentTerminalResult = (
  result: RuntimeInvocationResult,
  secretValues: readonly string[] = [],
): AgentTerminalResult => {
  const base = {
    schemaVersion: 'agent-terminal-result/v1' as const,
    invocationId: result.invocationId,
    pin: Object.freeze({ ...result.pin }),
  };
  if (result.status === 'succeeded') {
    const value = safeSuccessValue(result.value, secretValues);
    return value === undefined
      ? Object.freeze({ ...base, status: 'failed', error: genericFailure })
      : Object.freeze({ ...base, status: result.status, value });
  }
  if (result.status === 'cancelled') {
    return Object.freeze({ ...base, status: result.status });
  }
  return Object.freeze({
    ...base,
    status: result.status,
    error: sanitizeFailure(result, secretValues),
  });
};

export const sanitizeAgentResultLookup = (
  lookup: RuntimeResultLookup,
  secretValues: readonly string[] = [],
): AgentResultLookup => {
  if (lookup.state === 'completed') {
    return Object.freeze({
      state: lookup.state,
      result: sanitizeAgentTerminalResult(lookup.result, secretValues),
    });
  }
  if (
    lookup.state === 'running' &&
    (lookup.invocation.status === 'accepted' ||
      lookup.invocation.status === 'starting' ||
      lookup.invocation.status === 'running' ||
      lookup.invocation.status === 'cancelling')
  ) {
    return Object.freeze({
      state: lookup.state,
      invocation: Object.freeze({
        invocationId: lookup.invocation.invocationId,
        pin: Object.freeze({ ...lookup.invocation.pin }),
        status: lookup.invocation.status,
      }),
    });
  }
  return Object.freeze({ state: 'unknown' });
};

export const sanitizeCancelResult = (
  result: RuntimeCancelResult,
  secretValues: readonly string[] = [],
): CancelInvocationResult =>
  result.state === 'already_completed'
    ? Object.freeze({
        state: result.state,
        result: sanitizeAgentTerminalResult(result.result, secretValues),
      })
    : Object.freeze({ state: result.state });

export const sanitizeInvocationHandle = (
  handle: RuntimeInvocationHandle,
  secretValues: readonly string[] = [],
): AgentInvocationHandle =>
  Object.freeze({
    invocationId: handle.invocationId,
    pin: Object.freeze({ ...handle.pin }),
    result: async () => sanitizeAgentTerminalResult(await handle.result(), secretValues),
    cancel: async (reason?: string) =>
      sanitizeCancelResult(await handle.cancel(reason), secretValues),
  });
