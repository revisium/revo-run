import {
  RunManagerDatabasePreparationAbortedError,
  RunManagerDatabasePreparationAggregateError,
  RunManagerDatabasePreparationError,
  type RunManagerDatabasePreparationFailure,
  type RunManagerDatabasePreparationStage,
} from '../contracts/database-preparation.js';

export const preparationFailure = (
  stage: RunManagerDatabasePreparationStage,
  exitCode?: number | null,
  signal?: NodeJS.Signals | null,
): RunManagerDatabasePreparationError =>
  new RunManagerDatabasePreparationError(stage, exitCode, signal);

export const preparationAborted = (): RunManagerDatabasePreparationAbortedError =>
  new RunManagerDatabasePreparationAbortedError();

export const normalizePreparationFailures = (
  error: unknown,
  fallbackStage: RunManagerDatabasePreparationStage,
): RunManagerDatabasePreparationFailure[] => {
  if (
    error instanceof RunManagerDatabasePreparationError ||
    error instanceof RunManagerDatabasePreparationAbortedError
  ) {
    return [error];
  }
  if (error instanceof RunManagerDatabasePreparationAggregateError) {
    return [...error.errors];
  }
  return [preparationFailure(fallbackStage)];
};

export const throwPreparationFailures = (
  primary: RunManagerDatabasePreparationFailure | undefined,
  cleanup: readonly RunManagerDatabasePreparationFailure[],
): void => {
  if (primary === undefined && cleanup.length === 0) {
    return;
  }
  if (primary !== undefined && cleanup.length === 0) {
    throw primary;
  }
  throw new RunManagerDatabasePreparationAggregateError(primary, Object.freeze([...cleanup]));
};
