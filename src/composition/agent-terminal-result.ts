import { isJsonObject } from '../contracts/json.js';
import type { AgentTerminalResult } from './agent-port.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isPin = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ['agentId', 'agentVersion', 'definitionDigest']) &&
  isBoundedString(value.agentId, 256) &&
  isBoundedString(value.agentVersion, 256) &&
  isBoundedString(value.definitionDigest, 256);

const isBase = (value: Record<string, unknown>): boolean =>
  value.schemaVersion === 'agent-terminal-result/v1' &&
  isBoundedString(value.invocationId, 256) &&
  isPin(value.pin);

const isFailure = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ['code', 'message']) &&
  isBoundedString(value.code, 256) &&
  isBoundedString(value.message, 4_096);

/** Validates the sanitized private terminal carrier before it enters durable history. */
export const isAgentTerminalResult = (value: unknown): value is AgentTerminalResult => {
  if (!isRecord(value) || !isBase(value)) {
    return false;
  }
  if (value.status === 'succeeded') {
    return (
      hasExactKeys(value, ['schemaVersion', 'invocationId', 'pin', 'status', 'value']) &&
      isJsonObject(value.value)
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
