import { createRunNodeInstance } from './create-run-node-instance.js';
import { createRunOutput } from './create-run-output.js';
import { domainEvents } from './domain-events.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionMaterializationContext } from './run-progression-materialization-context.js';
import { validateRunProgressionNodeDelta } from './validate-run-progression-node-delta.js';

type WaitingStep = Extract<
  RunProgressionIntentStep,
  {
    readonly kind: 'resolve_gate' | 'complete_selector' | 'complete_join';
  }
>;

export const materializeRunProgressionWaitingNode = (
  context: RunProgressionMaterializationContext,
  step: WaitingStep,
): void => {
  const node = createRunNodeInstance(step.node);
  validateRunProgressionNodeDelta({
    node,
    nodeKey: step.nodeKey,
    projection: context.draft.projection(),
    transactionNow: context.transactionNow,
  });
  const logical = context.state.nodes.find((candidate) => candidate.nodeKey === step.nodeKey);
  if (node.status !== 'succeeded' || logical?.state !== 'terminal') {
    throw new TypeError('Run progression waiting-node completion is invalid.');
  }
  if (step.kind !== 'resolve_gate' && logical.outcome !== step.outcome) {
    throw new TypeError('Run progression waiting-node completion is invalid.');
  }
  if (
    step.kind === 'resolve_gate' &&
    !context.state.gateResolutions.some((item) => item.nodeKey === step.nodeKey)
  ) {
    throw new TypeError('Run progression waiting-node completion is invalid.');
  }
  const priorNode = context.draft.projection().nodes.find((candidate) => candidate.id === node.id);
  if (priorNode === undefined) {
    throw new TypeError('Run progression waiting node is missing.');
  }
  if (step.kind === 'resolve_gate') {
    const output = createRunOutput(step.output);
    context.draft.recordOutput(output);
    context.eventIntents.push(domainEvents.outputRecorded(output));
  }
  context.eventIntents.push(
    domainEvents.nodeTransitioned(node, priorNode.status, 'pipeline_progression'),
  );
  context.draft.recordNode(node);
};
