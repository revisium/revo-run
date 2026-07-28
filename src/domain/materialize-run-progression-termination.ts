import { createAttempt } from './create-attempt.js';
import { createRunNodeInstance } from './create-run-node-instance.js';
import { deriveRunProgressionAttemptEvent } from './derive-run-progression-attempt-event.js';
import { domainEvents } from './domain-events.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionMaterializationContext } from './run-progression-materialization-context.js';
import { validateRunProgressionAttemptDelta } from './validate-run-progression-attempt-delta.js';
import { validateRunProgressionNodeDelta } from './validate-run-progression-node-delta.js';
import { validateRunProgressionRetirement } from './validate-run-progression-retirement.js';

export const materializeRunProgressionTermination = (
  context: RunProgressionMaterializationContext,
  step: Extract<RunProgressionIntentStep, { readonly kind: 'terminate' }>,
): void => {
  if (
    context.state.phase !== 'terminal' ||
    context.state.terminal.nodeKey !== step.nodeKey ||
    context.state.terminal.outcome !== step.outcome
  ) {
    throw new TypeError('Run progression terminal step is invalid.');
  }
  for (const retirement of step.retirements) {
    const node = createRunNodeInstance(retirement.node);
    if (node.status !== 'retired' && node.status !== 'retiring') {
      throw new TypeError('Run progression retirement node is invalid.');
    }
    validateRunProgressionNodeDelta({
      node,
      nodeKey: node.nodeKey,
      projection: context.draft.projection(),
      transactionNow: context.transactionNow,
    });
    const priorNode = context.draft
      .projection()
      .nodes.find((candidate) => candidate.id === node.id);
    if (priorNode === undefined) {
      throw new TypeError('Run progression retirement node is missing.');
    }
    if (retirement.attempt !== null) {
      const attempt = createAttempt(retirement.attempt);
      if (attempt.nodeInstanceId !== node.id) {
        throw new TypeError('Run progression retirement Attempt is invalid.');
      }
      validateRunProgressionRetirement({
        attempt,
        node,
        projection: context.draft.projection(),
        transactionNow: context.transactionNow,
      });
      const priorAttempt = context.draft
        .projection()
        .attempts.find((candidate) => candidate.id === attempt.id);
      if (priorAttempt === undefined) {
        throw new TypeError('Run progression retirement Attempt is missing.');
      }
      validateRunProgressionAttemptDelta({
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
    } else {
      validateRunProgressionRetirement({
        attempt: null,
        node,
        projection: context.draft.projection(),
        transactionNow: context.transactionNow,
      });
    }
    context.eventIntents.push(
      domainEvents.nodeTransitioned(node, priorNode.status, 'pipeline_retirement'),
    );
    context.draft.recordNode(node);
  }
};
