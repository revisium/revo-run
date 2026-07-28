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

const expectedOrigin = (
  operation: RunProgressionAppliedReceipt['operation'],
): RunProgressionIntentStep['kind'] => {
  switch (operation) {
    case 'initialize':
      return 'initialize';
    case 'task_outcome':
      return 'complete_task';
    case 'consensus_verdict':
      return 'record_verdict';
    case 'human_gate_resolution':
      return 'resolve_gate';
    case 'retired_attempt_observation':
      return 'settle_retired_attempt';
  }
  throw new TypeError('Run progression operation is invalid.');
};

type GrammarState = {
  readonly selectorIds: Set<string>;
  readonly joinIds: Set<string>;
  readonly activationIds: Set<string>;
  readonly operationalStatuses: Map<string, string>;
  terminateIndex: number;
};

const recordUnique = (identities: Set<string>, identity: string, message: string): void => {
  if (identities.has(identity)) throw new TypeError(message);
  identities.add(identity);
};

const requireStatus = (
  state: GrammarState,
  nodeKey: string,
  expected: string,
  message: string,
): void => {
  if (state.operationalStatuses.get(nodeKey) !== expected) throw new TypeError(message);
};

const validateEffect = (
  step: RunProgressionIntentStep,
  index: number,
  length: number,
  state: GrammarState,
): void => {
  if (step.kind === 'complete_selector') {
    requireStatus(
      state,
      step.nodeKey,
      'selector_waiting',
      'Run progression selector completion status is invalid.',
    );
    recordUnique(
      state.selectorIds,
      step.node.id,
      'Run progression selector completion is duplicated.',
    );
    state.operationalStatuses.set(step.nodeKey, step.node.status);
  }
  if (step.kind === 'resolve_gate') {
    requireStatus(
      state,
      step.nodeKey,
      'gate_waiting',
      'Run progression gate resolution status is invalid.',
    );
    state.operationalStatuses.set(step.nodeKey, step.node.status);
  }
  if (step.kind === 'complete_join') {
    requireStatus(
      state,
      step.nodeKey,
      'join_waiting',
      'Run progression join completion status is invalid.',
    );
    recordUnique(state.joinIds, step.node.id, 'Run progression join completion is duplicated.');
    state.operationalStatuses.set(step.nodeKey, step.node.status);
  }
  if (step.kind === 'activate_node') {
    const identity = `${step.node.runId}\u0000${step.node.activationId}`;
    recordUnique(state.activationIds, identity, 'Run progression activation effect is duplicated.');
    state.operationalStatuses.set(step.nodeKey, step.node.status);
  }
  if (step.kind === 'terminate') {
    if (state.terminateIndex !== -1 || index !== length - 1) {
      throw new TypeError('Run progression terminal effect order is invalid.');
    }
    state.terminateIndex = index;
  }
};

const validateTerminalGrammar = (
  receipt: RunProgressionAppliedReceipt,
  steps: readonly RunProgressionIntentStep[],
  terminateIndex: number,
): void => {
  const terminal = receipt.outcome.kind === 'terminal' ? receipt.outcome.terminal : null;
  const cleanup = receipt.operation === 'retired_attempt_observation';
  const terminateStep = terminateIndex === -1 ? undefined : steps[terminateIndex];
  const terminalMismatch =
    terminal !== null &&
    (terminateStep?.kind !== 'terminate' ||
      terminateStep.nodeKey !== terminal.nodeKey ||
      terminateStep.outcome !== terminal.outcome);
  if (
    (!cleanup && terminalMismatch) ||
    (terminal === null && terminateIndex !== -1) ||
    (cleanup && terminateIndex !== -1)
  ) {
    throw new TypeError('Run progression terminal receipt grammar is invalid.');
  }
};

export const validateRunProgressionStepGrammar = (input: {
  readonly projection: RunProgressionProjection;
  readonly receipt: RunProgressionAppliedReceipt;
  readonly steps: readonly RunProgressionIntentStep[];
}): void => {
  const state: GrammarState = {
    activationIds: new Set(),
    joinIds: new Set(),
    operationalStatuses: new Map(input.projection.nodes.map((node) => [node.nodeKey, node.status])),
    selectorIds: new Set(),
    terminateIndex: -1,
  };
  for (const [index, step] of input.steps.entries()) {
    validateEffect(step, index, input.steps.length, state);
  }
  validateTerminalGrammar(input.receipt, input.steps, state.terminateIndex);
  if (
    input.steps[0]?.kind !== expectedOrigin(input.receipt.operation) ||
    input.steps.slice(1).some((step) => originKinds.has(step.kind))
  ) {
    throw new TypeError('Run progression step batch grammar is invalid.');
  }
};
