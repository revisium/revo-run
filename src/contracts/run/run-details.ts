import type { RunNodeExecution } from '../executor/run-node-execution.js';
import type { RunSnapshot } from './run.js';

export interface RunDetails {
  readonly run: RunSnapshot;
  readonly nodeExecutions: readonly RunNodeExecution[];
}
