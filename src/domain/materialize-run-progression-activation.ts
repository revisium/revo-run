import { createRunNodeInstance } from './create-run-node-instance.js';
import { domainEvents } from './domain-events.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionMaterializationContext } from './run-progression-materialization-context.js';
import { validateRunProgressionActivation } from './validate-run-progression-activation.js';

export const materializeRunProgressionActivation = (
  context: RunProgressionMaterializationContext,
  step: Extract<RunProgressionIntentStep, { readonly kind: 'activate_node' }>,
): void => {
  const node = createRunNodeInstance(step.node);
  validateRunProgressionActivation({
    node,
    projection: context.draft.projection(),
    step,
    transactionNow: context.transactionNow,
  });
  if (!context.state.nodes.some((candidate) => candidate.nodeKey === step.nodeKey)) {
    throw new TypeError('Run progression activation state is invalid.');
  }
  context.draft.recordNode(node);
  context.eventIntents.push(domainEvents.activated(node));
};
