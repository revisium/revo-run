import Schema from 'typebox/schema';

import type { ListRunsInput } from '../contracts/run/list-runs.js';
import { RunStatusSchema } from '../contracts/run/run.js';
import { ownValue } from './own-value.js';

const RunStatusValidator = Schema.Compile(RunStatusSchema);
const keys = new Set(['statuses', 'createdFrom', 'createdThrough', 'offset', 'limit']);

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

const isSafeIntegerBetween = (value: unknown, minimum: number, maximum: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export const isListRunsInput = (value: unknown): value is ListRunsInput => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).some((key) => !keys.has(key))) {
    return false;
  }

  const statuses = ownValue(value, 'statuses');
  const createdFrom = ownValue(value, 'createdFrom');
  const createdThrough = ownValue(value, 'createdThrough');
  const offset = ownValue(value, 'offset');
  const limit = ownValue(value, 'limit');
  if (
    statuses !== undefined &&
    (!Array.isArray(statuses) ||
      statuses.length < 1 ||
      statuses.length > 5 ||
      new Set(statuses).size !== statuses.length ||
      !statuses.every((status) => RunStatusValidator.Check(status)))
  ) {
    return false;
  }
  if (createdFrom !== undefined && !isValidDate(createdFrom)) {
    return false;
  }
  if (createdThrough !== undefined && !isValidDate(createdThrough)) {
    return false;
  }
  if (offset !== undefined && !isSafeIntegerBetween(offset, 0, Number.MAX_SAFE_INTEGER)) {
    return false;
  }
  if (limit !== undefined && !isSafeIntegerBetween(limit, 1, 100)) {
    return false;
  }

  return !(
    isValidDate(createdFrom) &&
    isValidDate(createdThrough) &&
    createdFrom.getTime() > createdThrough.getTime()
  );
};
