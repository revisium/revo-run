import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import type { RunDetails } from '../../contracts/run/run-details.js';
import type { RunSnapshot } from '../../contracts/run/run.js';

export const mapRunDetails = (
  run: RunSnapshot,
  nodeExecutions: readonly RunNodeExecution[],
): RunDetails => ({
  run,
  nodeExecutions,
});
