import { canonicalizeJson } from '../policy/index.js';
import { isRunNodeStatusTransitionAllowed } from './is-run-node-status-transition-allowed.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunProgressionProjection } from './run-progression-projection.js';

export const validateRunProgressionNodeDelta = (input: {
  readonly node: RunNodeInstance;
  readonly nodeKey: string;
  readonly projection: RunProgressionProjection;
  readonly transactionNow: number;
}): void => {
  const prior = input.projection.nodes.find((candidate) => candidate.nodeKey === input.nodeKey);
  if (
    input.node.id !== prior?.id ||
    input.node.runId !== prior.runId ||
    input.node.nodeKey !== input.nodeKey ||
    input.node.activationId !== prior.activationId ||
    input.node.activationKey !== prior.activationKey ||
    input.node.parentActivationId !== prior.parentActivationId ||
    input.node.forkScopeKey !== prior.forkScopeKey ||
    input.node.branchKey !== prior.branchKey ||
    input.node.iteration !== prior.iteration ||
    canonicalizeJson(input.node.activationContext) !== canonicalizeJson(prior.activationContext) ||
    input.node.createdAt !== prior.createdAt ||
    !isRunNodeStatusTransitionAllowed(prior.status, input.node.status) ||
    input.node.revision !== prior.revision + 1 ||
    input.node.updatedAt !== input.transactionNow
  ) {
    throw new TypeError('Run progression node delta is invalid.');
  }
};
