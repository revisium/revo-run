export type RunManagerDatabasePreparationStage =
  | 'input-validation'
  | 'dbos-cli-resolution'
  | 'database-connection'
  | 'database-session-lost'
  | 'advisory-lock-acquisition'
  | 'migration-version-read'
  | 'dbos-schema-migration'
  | 'cleanup';

export interface PrepareRunManagerDatabaseOptions {
  readonly databaseUrl: string;
  readonly signal?: AbortSignal;
}

export interface PrepareRunManagerDatabaseResult {
  readonly schema: 'dbos';
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrated: boolean;
}

export class RunManagerDatabasePreparationError extends Error {
  readonly code = 'run_manager_database_preparation_failed';

  constructor(
    readonly stage: RunManagerDatabasePreparationStage,
    readonly exitCode?: number | null,
    readonly signal?: NodeJS.Signals | null,
  ) {
    super('Run manager database preparation failed.');
    this.name = 'RunManagerDatabasePreparationError';
  }
}

export class RunManagerDatabasePreparationAbortedError extends Error {
  readonly code = 'run_manager_database_preparation_aborted';

  constructor() {
    super('Run manager database preparation was aborted.');
    this.name = 'RunManagerDatabasePreparationAbortedError';
  }
}

export type RunManagerDatabasePreparationFailure =
  | RunManagerDatabasePreparationError
  | RunManagerDatabasePreparationAbortedError;
