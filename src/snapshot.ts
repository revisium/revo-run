import type { ExecutionPlanPin, JsonValue, RunSnapshot } from './types.js';

const copyJson = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(copyJson));
  const copy: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value)) copy[key] = copyJson(member);
  return Object.freeze(copy);
};

export const createSnapshot = (
  id: string,
  planPin: ExecutionPlanPin,
  input: JsonValue,
): RunSnapshot =>
  Object.freeze({
    id,
    planPin: Object.freeze({ ...planPin }),
    input: copyJson(input),
    status: 'pending',
    result: null,
    error: null,
  });
