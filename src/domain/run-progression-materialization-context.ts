import type { RunEventIntent } from './run-event-intent.js';
import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import type { createRunProgressionDraft } from './run-progression-draft.js';
import type { RunProgressionProjection } from './run-progression-projection.js';
import type { RunProgressionState } from './run-progression-state.js';

export type RunProgressionMaterializationContext = {
  readonly draft: ReturnType<typeof createRunProgressionDraft>;
  readonly eventIntents: RunEventIntent[];
  readonly projection: RunProgressionProjection;
  readonly receipt: RunProgressionAppliedReceipt;
  readonly state: RunProgressionState;
  readonly transactionNow: number;
};
