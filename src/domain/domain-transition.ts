import type { Attempt } from './attempt.js';
import type { RunEventIntent } from './run-event-intent.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';
import type { Run } from './run.js';

export interface DomainTransition {
  readonly run: Run;
  readonly nodes: readonly RunNodeInstance[];
  readonly attempts: readonly Attempt[];
  readonly outputs: readonly RunOutput[];
  readonly eventIntents: readonly RunEventIntent[];
  readonly changed: boolean;
}
