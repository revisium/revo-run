import {
  RunManagerDatabasePreparationAbortedError,
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
): RunManagerDatabasePreparationFailure => {
  if (
    error instanceof RunManagerDatabasePreparationError ||
    error instanceof RunManagerDatabasePreparationAbortedError
  ) {
    return error;
  }
  return preparationFailure(fallbackStage);
};
