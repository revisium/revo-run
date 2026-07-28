import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionProjection } from './run-progression-projection.js';

const originKinds = new Set([
  'initialize',
  'complete_task',
  'record_verdict',
  'resolve_gate',
  'settle_retired_attempt',
]);

export const validateRunProgressionStepGrammar = (input: {
  readonly projection: RunProgressionProjection;
  readonly receipt: RunProgressionAppliedReceipt;
  readonly steps: readonly RunProgressionIntentStep[];
}): void => {
  const expected =
    input.receipt.operation === 'initialize'
      ? 'initialize'
      : input.receipt.operation === 'task_outcome'
        ? 'complete_task'
        : input.receipt.operation === 'consensus_verdict'
          ? 'record_verdict'
          : input.receipt.operation === 'human_gate_resolution'
            ? 'resolve_gate'
            : 'settle_retired_attempt';
  const selectorIds = new Set<string>();
  const joinIds = new Set<string>();
  const activationIds = new Set<string>();
  const operationalStatuses = new Map(
    input.projection.nodes.map((node) => [node.nodeKey, node.status]),
  );
  let terminateIndex = -1;
  for (const [index, step] of input.steps.entries()) {
    if (step.kind === 'complete_selector') {
      if (operationalStatuses.get(step.nodeKey) !== 'selector_waiting') {
        throw new TypeError('Run progression selector completion status is invalid.');
      }
      if (selectorIds.has(step.node.id)) {
        throw new TypeError('Run progression selector completion is duplicated.');
      }
      selectorIds.add(step.node.id);
      operationalStatuses.set(step.nodeKey, step.node.status);
    }
    if (step.kind === 'resolve_gate') {
      if (operationalStatuses.get(step.nodeKey) !== 'gate_waiting') {
        throw new TypeError('Run progression gate resolution status is invalid.');
      }
      operationalStatuses.set(step.nodeKey, step.node.status);
    }
    if (step.kind === 'complete_join') {
      if (operationalStatuses.get(step.nodeKey) !== 'join_waiting') {
        throw new TypeError('Run progression join completion status is invalid.');
      }
      if (joinIds.has(step.node.id)) {
        throw new TypeError('Run progression join completion is duplicated.');
      }
      joinIds.add(step.node.id);
      operationalStatuses.set(step.nodeKey, step.node.status);
    }
    if (step.kind === 'activate_node') {
      const identity = `${step.node.runId}\u0000${step.node.activationId}`;
      if (activationIds.has(identity)) {
        throw new TypeError('Run progression activation effect is duplicated.');
      }
      activationIds.add(identity);
      operationalStatuses.set(step.nodeKey, step.node.status);
    }
    if (step.kind === 'terminate') {
      if (terminateIndex !== -1 || index !== input.steps.length - 1) {
        throw new TypeError('Run progression terminal effect order is invalid.');
      }
      terminateIndex = index;
    }
  }
  const terminal =
    input.receipt.outcome.kind === 'terminal' ? input.receipt.outcome.terminal : null;
  const cleanup = input.receipt.operation === 'retired_attempt_observation';
  const terminateStep = terminateIndex === -1 ? undefined : input.steps[terminateIndex];
  if (
    (!cleanup &&
      terminal !== null &&
      (terminateStep?.kind !== 'terminate' ||
        terminateStep.nodeKey !== terminal.nodeKey ||
        terminateStep.outcome !== terminal.outcome)) ||
    (terminal === null && terminateIndex !== -1) ||
    (cleanup && terminateIndex !== -1)
  ) {
    throw new TypeError('Run progression terminal receipt grammar is invalid.');
  }
  if (
    input.steps[0]?.kind !== expected ||
    input.steps.slice(1).some((step) => originKinds.has(step.kind))
  ) {
    throw new TypeError('Run progression step batch grammar is invalid.');
  }
};
