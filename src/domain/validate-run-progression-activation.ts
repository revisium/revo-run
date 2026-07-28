import { deriveActivationKey } from './derive-activation-key.js';
import { deriveChildForkScopeKey } from './derive-child-fork-scope-key.js';
import { deriveRootForkScopeKey } from './derive-root-fork-scope-key.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionProjection } from './run-progression-projection.js';

const requiredNodeStatus = (
  kind: Extract<RunProgressionIntentStep, { readonly kind: 'activate_node' }>['nodeKind'],
): RunNodeInstance['status'] => {
  if (kind === 'task') return 'ready';
  if (kind === 'human_gate') return 'gate_waiting';
  if (kind === 'join') return 'join_waiting';
  return 'selector_waiting';
};

export const validateRunProgressionActivation = (input: {
  readonly step: Extract<RunProgressionIntentStep, { readonly kind: 'activate_node' }>;
  readonly node: RunNodeInstance;
  readonly projection: RunProgressionProjection;
  readonly transactionNow: number;
}): void => {
  const { node, projection, step, transactionNow } = input;
  if (
    node.nodeKey !== step.nodeKey ||
    node.status !== requiredNodeStatus(step.nodeKind) ||
    node.revision !== 0 ||
    node.iteration !== 0 ||
    node.activationKey !==
      deriveActivationKey({
        branchKey: node.branchKey,
        forkScopeKey: node.forkScopeKey,
        iteration: node.iteration,
        nodeKey: node.nodeKey,
      }) ||
    node.createdAt !== transactionNow ||
    node.updatedAt !== transactionNow
  ) {
    throw new TypeError('Run progression activation materialization is invalid.');
  }
  if (step.cause.kind === 'entry') {
    if (
      node.parentActivationId !== null ||
      node.branchKey !== null ||
      node.forkScopeKey !== deriveRootForkScopeKey(node.runId)
    ) {
      throw new TypeError('Run progression entry activation cause is invalid.');
    }
    return;
  }
  const cause = step.cause;
  const predecessor = projection.nodes.find(
    (candidate) =>
      candidate.nodeKey === cause.predecessorNodeKey &&
      candidate.activationId === cause.predecessorActivationId,
  );
  if (node.parentActivationId !== predecessor?.activationId) {
    throw new TypeError('Run progression predecessor activation cause is invalid.');
  }
  if (cause.kind === 'successor') {
    if (
      node.forkScopeKey !== predecessor.forkScopeKey ||
      node.branchKey !== predecessor.branchKey
    ) {
      throw new TypeError('Run progression successor activation cause is invalid.');
    }
    return;
  }
  const fork = projection.nodes.find(
    (candidate) =>
      candidate.nodeKey === cause.forkNodeKey && candidate.activationId === cause.forkActivationId,
  );
  const childScope =
    fork === undefined ? null : deriveChildForkScopeKey(fork.forkScopeKey, fork.activationId);
  const entryOrJoin = cause.relation === 'entry' || cause.relation === 'join';
  const predecessorMatchesRelation =
    fork !== undefined &&
    (entryOrJoin
      ? predecessor.id === fork.id
      : predecessor.forkScopeKey === childScope &&
        predecessor.branchKey === cause.branchKey &&
        predecessor.parentActivationId !== null);
  if (
    fork === undefined ||
    !predecessorMatchesRelation ||
    node.forkScopeKey !== childScope ||
    (cause.relation === 'join'
      ? node.branchKey !== null || cause.branchKey !== null
      : node.branchKey === null || node.branchKey !== cause.branchKey)
  ) {
    throw new TypeError('Run progression fork activation cause is invalid.');
  }
};
