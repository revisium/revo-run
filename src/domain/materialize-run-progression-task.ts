import { createAttempt } from './create-attempt.js';
import { createRunNodeInstance } from './create-run-node-instance.js';
import { createRunOutput } from './create-run-output.js';
import { deriveRunProgressionAttemptEvent } from './derive-run-progression-attempt-event.js';
import { domainEvents } from './domain-events.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionMaterializationContext } from './run-progression-materialization-context.js';
import { validateRunProgressionAttemptDelta } from './validate-run-progression-attempt-delta.js';
import { validateRunProgressionNodeDelta } from './validate-run-progression-node-delta.js';

export const materializeRunProgressionTask = (
  context: RunProgressionMaterializationContext,
  step: Extract<RunProgressionIntentStep, { readonly kind: 'complete_task' }>,
): void => {
  const node = createRunNodeInstance(step.node);
  validateRunProgressionNodeDelta({
    node,
    nodeKey: step.nodeKey,
    projection: context.draft.projection(),
    transactionNow: context.transactionNow,
  });
  const logical = context.state.nodes.find((candidate) => candidate.nodeKey === step.nodeKey);
  if (
    logical?.state !== 'terminal' ||
    logical.outcome !== step.outcome ||
    !['succeeded', 'failed', 'cancelled', 'skipped'].includes(node.status)
  ) {
    throw new TypeError('Run progression task completion is invalid.');
  }
  const priorNode = context.draft.projection().nodes.find((candidate) => candidate.id === node.id);
  if (priorNode === undefined) throw new TypeError('Run progression task node is missing.');
  if (step.attempt !== null) {
    const attempt = createAttempt(step.attempt);
    if (attempt.nodeInstanceId !== node.id || attempt.runId !== node.runId) {
      throw new TypeError('Run progression task Attempt is invalid.');
    }
    const priorAttempt = context.draft
      .projection()
      .attempts.find((candidate) => candidate.id === attempt.id);
    if (priorAttempt === undefined) {
      throw new TypeError('Run progression task Attempt is missing.');
    }
    validateRunProgressionAttemptDelta({
      allowFaultChange: true,
      next: attempt,
      prior: priorAttempt,
      transactionNow: context.transactionNow,
    });
    const attemptEvent = deriveRunProgressionAttemptEvent({
      next: attempt,
      node,
      prior: priorAttempt,
    });
    if (attemptEvent !== null) context.eventIntents.push(attemptEvent);
    context.draft.recordAttempt(attempt);
  }
  for (const value of step.outputs) {
    const output = createRunOutput(value);
    if (output.runId !== context.projection.run.id) {
      throw new TypeError('Run progression output is invalid.');
    }
    context.draft.recordOutput(output);
    context.eventIntents.push(domainEvents.outputRecorded(output));
  }
  context.eventIntents.push(
    domainEvents.nodeTransitioned(node, priorNode.status, 'pipeline_progression'),
  );
  context.draft.recordNode(node);
};
