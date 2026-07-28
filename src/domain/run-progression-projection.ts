import type { Attempt } from './attempt.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';
import type { Run } from './run.js';

export interface RunProgressionProjection {
  readonly run: Run;
  readonly nodes: readonly RunNodeInstance[];
  readonly attempts: readonly Attempt[];
  readonly outputs: readonly RunOutput[];
}
