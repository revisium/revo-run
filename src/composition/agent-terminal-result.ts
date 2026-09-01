import { isJsonObject, isJsonValue } from '../contracts/json.js';
import type { AgentTerminalResult } from './agent-port.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isDefinitionDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

const isPin = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ['agentId', 'agentVersion', 'definitionDigest']) &&
  isBoundedString(value.agentId, 256) &&
  isBoundedString(value.agentVersion, 256) &&
  isDefinitionDigest(value.definitionDigest);

const isBase = (value: Record<string, unknown>): boolean =>
  value.schemaVersion === 'agent-terminal-result/v1' &&
  isBoundedString(value.invocationId, 256) &&
  isPin(value.pin);

const isFailure = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['code', 'message', 'phase', 'retryable', 'details'].includes(key),
  ) &&
  'code' in value &&
  'message' in value &&
  isBoundedString(value.code, 256) &&
  isBoundedString(value.message, 4_096) &&
  (value.phase === undefined || isBoundedString(value.phase, 256)) &&
  (value.retryable === undefined || typeof value.retryable === 'boolean') &&
  (value.details === undefined || isJsonObject(value.details));

const isUsage = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).every((key) => ['inputTokens', 'outputTokens', 'totalTokens'].includes(key)) &&
  Object.values(value).every(
    (tokens) => typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0,
  );

/** Validates the sanitized private terminal carrier before it enters durable history. */
export const isAgentTerminalResult = (value: unknown): value is AgentTerminalResult => {
  if (!isRecord(value) || !isJsonValue(value) || !isBase(value)) {
    return false;
  }
  if (value.status === 'succeeded') {
    return (
      Object.keys(value).every((key) =>
        ['schemaVersion', 'invocationId', 'pin', 'status', 'value', 'usage'].includes(key),
      ) &&
      ['schemaVersion', 'invocationId', 'pin', 'status', 'value'].every((key) => key in value) &&
      isJsonValue(value.value) &&
      (value.usage === undefined || isUsage(value.usage))
    );
  }
  if (value.status === 'failed' || value.status === 'timed_out') {
    return (
      hasExactKeys(value, ['schemaVersion', 'invocationId', 'pin', 'status', 'error']) &&
      isFailure(value.error)
    );
  }
  return (
    value.status === 'cancelled' &&
    hasExactKeys(value, ['schemaVersion', 'invocationId', 'pin', 'status'])
  );
};
