import {
  cloneFrozenJson,
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
} from './json.js';
import type { RunPublicFailure } from './observation.js';

const maximumCodePoints = 256;
const maximumMessageCodePoints = 4_096;
const maximumDetailsBytes = 65_536;

const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && Array.from(value).length > 0 && Array.from(value).length <= maximum;

const boundedDetails = (value: unknown): JsonObject | null => {
  if (!isJsonObject(value)) {
    return null;
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maximumDetailsBytes) {
    return null;
  }
  return cloneFrozenJson(value);
};

const isRecord = (value: object): value is Record<string, unknown> =>
  Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;

const fallback = (): RunPublicFailure =>
  Object.freeze({
    code: 'revo.run.execution_failed',
    message: 'Run execution failed.',
    path: null,
    details: null,
  });

export const normalizeScriptFailure = (value: unknown): RunPublicFailure => {
  if (typeof value !== 'object' || value === null) {
    return fallback();
  }
  if (!isRecord(value)) {
    return fallback();
  }
  const candidate = value;
  if (!boundedString(candidate.code, maximumCodePoints)) {
    return fallback();
  }
  return Object.freeze({
    code: candidate.code,
    message: boundedString(candidate.message, maximumMessageCodePoints)
      ? candidate.message
      : 'Script execution failed.',
    path: null,
    details: boundedDetails(candidate.details),
  });
};

export const normalizeAgentFailure = (value: unknown): RunPublicFailure => {
  if (typeof value !== 'object' || value === null || !isRecord(value)) {
    return fallback();
  }
  if (!boundedString(value.code, maximumCodePoints)) {
    return fallback();
  }
  return Object.freeze({
    code: value.code,
    message: boundedString(value.message, maximumMessageCodePoints)
      ? value.message
      : 'Agent execution failed.',
    path: null,
    details: null,
  });
};

export const pipelineFailure = (code: unknown): RunPublicFailure =>
  boundedString(code, maximumCodePoints)
    ? Object.freeze({ code, message: 'Pipeline execution failed.', path: null, details: null })
    : fallback();

export const unknownRunFailure = (): RunPublicFailure => fallback();

export const asJsonValue = (value: unknown): JsonValue | null =>
  isJsonValue(value) ? value : null;
