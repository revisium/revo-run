import type { Attempt, Run, RunNodeInstance } from '../domain/index.js';

export interface RunStoreTakeoverChange {
  readonly run: Run;
  readonly node: RunNodeInstance;
  readonly attempt: Attempt;
}
