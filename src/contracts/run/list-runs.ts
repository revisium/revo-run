import type { RunStatus, RunSummary } from './run.js';

export interface ListRunsInput {
  readonly statuses?: readonly RunStatus[];
  readonly createdFrom?: Date;
  readonly createdThrough?: Date;
  readonly offset?: number;
  readonly limit?: number;
}

export interface RunPage {
  readonly items: readonly RunSummary[];
  readonly nextOffset?: number;
}
