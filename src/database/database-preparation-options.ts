import type { PrepareRunManagerDatabaseOptions } from '../contracts/database-preparation.js';
import { preparationFailure } from './preparation-failures.js';

export type ValidatedDatabasePreparationOptions = Readonly<{
  databaseUrl: string;
  signal?: AbortSignal;
}>;

export const validateDatabasePreparationOptions = (
  options: PrepareRunManagerDatabaseOptions,
): ValidatedDatabasePreparationOptions => {
  const signal =
    typeof options === 'object' && options !== null && 'signal' in options
      ? options.signal
      : undefined;
  if (
    typeof options !== 'object' ||
    options === null ||
    !('databaseUrl' in options) ||
    typeof options.databaseUrl !== 'string' ||
    Object.keys(options).some((key) => key !== 'databaseUrl' && key !== 'signal') ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    throw preparationFailure('input-validation');
  }
  try {
    const url = new URL(options.databaseUrl);
    if (
      (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
      url.hostname.length === 0 ||
      url.pathname.length <= 1
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw preparationFailure('input-validation');
  }
  return {
    databaseUrl: options.databaseUrl,
    ...(signal instanceof AbortSignal ? { signal } : {}),
  };
};
