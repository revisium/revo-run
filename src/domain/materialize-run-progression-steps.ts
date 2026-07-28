import type { Attempt } from './attempt.js';
import { materializeRunProgressionActivation } from './materialize-run-progression-activation.js';
import { materializeRunProgressionSettlement } from './materialize-run-progression-settlement.js';
import { materializeRunProgressionTask } from './materialize-run-progression-task.js';
import { materializeRunProgressionTermination } from './materialize-run-progression-termination.js';
import { materializeRunProgressionWaitingNode } from './materialize-run-progression-waiting-node.js';
import type { RunEventIntent } from './run-event-intent.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';
import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import { createRunProgressionDraft } from './run-progression-draft.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionProjection } from './run-progression-projection.js';
import type { RunProgressionState } from './run-progression-state.js';

type MaterializedSteps = {
  readonly nodes: readonly RunNodeInstance[];
  readonly attempts: readonly Attempt[];
  readonly outputs: readonly RunOutput[];
  readonly eventIntents: readonly RunEventIntent[];
};

export const materializeRunProgressionSteps = (input: {
  readonly projection: RunProgressionProjection;
  readonly state: RunProgressionState;
  readonly steps: readonly RunProgressionIntentStep[];
  readonly receipt: RunProgressionAppliedReceipt;
  readonly transactionNow: number;
}): MaterializedSteps => {
  const draft = createRunProgressionDraft(input.projection);
  const eventIntents: RunEventIntent[] = [];
  const context = { ...input, draft, eventIntents };
  let initializeCount = 0;
  for (const step of input.steps) {
    switch (step.kind) {
      case 'initialize':
        initializeCount += 1;
        break;
      case 'record_verdict':
        if (
          !input.state.candidateVerdicts.some(
            (item) => item.nodeKey === step.nodeKey && item.candidateKey === step.candidateKey,
          )
        ) {
          throw new TypeError('Run progression verdict step is invalid.');
        }
        break;
      case 'activate_node':
        materializeRunProgressionActivation(context, step);
        break;
      case 'complete_task':
        materializeRunProgressionTask(context, step);
        break;
      case 'resolve_gate':
      case 'complete_selector':
      case 'complete_join':
        materializeRunProgressionWaitingNode(context, step);
        break;
      case 'terminate':
        materializeRunProgressionTermination(context, step);
        break;
      case 'settle_retired_attempt':
        materializeRunProgressionSettlement(context, step);
        break;
    }
  }
  if (initializeCount > 1 || (initializeCount === 1 && input.steps[0]?.kind !== 'initialize')) {
    throw new TypeError('Run progression initialization order is invalid.');
  }
  return Object.freeze({
    attempts: draft.attemptDeltas(),
    eventIntents: Object.freeze(eventIntents),
    nodes: draft.nodeDeltas(),
    outputs: draft.outputDeltas(),
  });
};
