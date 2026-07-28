import { canonicalizeJson } from '../policy/index.js';
import { createAttempt } from './create-attempt.js';
import { createRunNodeInstance } from './create-run-node-instance.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionMaterializationContext } from './run-progression-materialization-context.js';
import { validateRunProgressionAttemptDelta } from './validate-run-progression-attempt-delta.js';
import { validateRunProgressionNodeDelta } from './validate-run-progression-node-delta.js';

export const materializeRunProgressionSettlement = (
  context: RunProgressionMaterializationContext,
  step: Extract<RunProgressionIntentStep, { readonly kind: 'settle_retired_attempt' }>,
): void => {
  const node = createRunNodeInstance(step.node);
  const attempt = createAttempt(step.attempt);
  const priorNode = context.draft
    .projection()
    .nodes.find((candidate) => candidate.nodeKey === step.nodeKey);
  const priorAttempt = context.draft
    .projection()
    .attempts.find((candidate) => candidate.id === step.attemptId);
  if (
    priorNode?.status !== 'retiring' ||
    priorAttempt?.progressionClosedAt === null ||
    priorAttempt === undefined ||
    node.status !== 'retired' ||
    attempt.id !== step.attemptId ||
    canonicalizeJson(context.state) !== canonicalizeJson(context.projection.run.progression)
  ) {
    throw new TypeError('Run progression retired Attempt settlement is invalid.');
  }
  const observation =
    context.receipt.operation === 'retired_attempt_observation'
      ? context.receipt.attemptObservation
      : null;
  if (
    observation?.attemptId !== attempt.id ||
    observation.nodeKey !== step.nodeKey ||
    observation.status !== attempt.status ||
    observation.terminalAt !== attempt.terminalAt ||
    canonicalizeJson(observation.fault) !== canonicalizeJson(attempt.fault)
  ) {
    throw new TypeError('Run progression retired Attempt observation is inconsistent.');
  }
  validateRunProgressionAttemptDelta({
    allowFaultChange: true,
    next: attempt,
    prior: priorAttempt,
    transactionNow: context.transactionNow,
  });
  validateRunProgressionNodeDelta({
    node,
    nodeKey: step.nodeKey,
    projection: context.draft.projection(),
    transactionNow: context.transactionNow,
  });
  context.draft.recordNode(node);
  context.draft.recordAttempt(attempt);
};
