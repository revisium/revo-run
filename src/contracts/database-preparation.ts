export type RunManagerDatabasePreparationStage =
  | 'input-validation'
  | 'dbos-cli-resolution'
  | 'temporary-directory-creation'
  | 'database-connection'
  | 'database-session-lost'
  | 'advisory-lock-acquisition'
  | 'migration-version-read'
  | 'dbos-schema-migration'
  | 'advisory-lock-release'
  | 'database-connection-close'
  | 'temporary-directory-removal';

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

export class RunManagerDatabasePreparationAggregateError extends AggregateError {
  readonly code = 'run_manager_database_preparation_cleanup_failed';
  override readonly errors: RunManagerDatabasePreparationFailure[];
  readonly primary: RunManagerDatabasePreparationFailure | undefined;
  readonly cleanup: readonly RunManagerDatabasePreparationFailure[];

  constructor(
    primary: RunManagerDatabasePreparationFailure | undefined,
    cleanup: readonly RunManagerDatabasePreparationFailure[],
  ) {
    const orderedCleanup = Object.freeze([...cleanup]);
    const orderedErrors: RunManagerDatabasePreparationFailure[] = [
      ...(primary === undefined ? [] : [primary]),
      ...orderedCleanup,
    ];
    Object.freeze(orderedErrors);
    super(orderedErrors, 'Run manager database preparation and cleanup failed.');
    this.name = 'RunManagerDatabasePreparationAggregateError';
    this.primary = primary;
    this.cleanup = orderedCleanup;
    this.errors = orderedErrors;
  }
}
