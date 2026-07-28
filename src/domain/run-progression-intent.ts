import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionState } from './run-progression-state.js';

export interface RunProgressionIntent {
  readonly nextState: RunProgressionState;
  readonly steps: readonly RunProgressionIntentStep[];
  readonly receipt: RunProgressionAppliedReceipt;
}
