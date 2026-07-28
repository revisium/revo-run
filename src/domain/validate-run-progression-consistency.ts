import { canonicalizeJson } from '../policy/index.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionState } from './run-progression-state.js';
import type { Run } from './run.js';

const enabledStatuses = new Set([
  'ready',
  'executing',
  'retry_waiting',
  'unknown',
  'gate_waiting',
  'join_waiting',
  'selector_waiting',
]);

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);

type ConsistencyInput = {
  readonly priorState: RunProgressionState;
  readonly run: Run;
  readonly nodes: readonly RunNodeInstance[];
  readonly state: RunProgressionState;
  readonly receipt: RunProgressionAppliedReceipt;
  readonly steps: readonly RunProgressionIntentStep[];
};

const validateOccurrence = ({ receipt, run, state }: ConsistencyInput): void => {
  if (
    receipt.occurrenceKey !== state.occurrenceKey ||
    run.progression.occurrenceKey !== state.occurrenceKey
  ) {
    throw new TypeError('Run progression occurrence is inconsistent.');
  }
};

const validateOperationalNodes = (input: ConsistencyInput): Map<string, RunNodeInstance> => {
  const { run, state } = input;
  const nodes = new Map(input.nodes.map((node) => [node.nodeKey, node]));
  if (
    input.nodes.some(
      (node) =>
        node.runId === run.id && !state.nodes.some((logical) => logical.nodeKey === node.nodeKey),
    )
  ) {
    throw new TypeError('Run progression operational node has no logical node.');
  }
  for (const logical of state.nodes) {
    const node = nodes.get(logical.nodeKey);
    if (node === undefined) {
      throw new TypeError('Run progression logical node has no operational node.');
    }
    if (logical.state === 'enabled' && !enabledStatuses.has(node.status)) {
      throw new TypeError('Run progression enabled node status is inconsistent.');
    }
    if (logical.state === 'terminal' && !terminalStatuses.has(node.status)) {
      throw new TypeError('Run progression terminal node status is inconsistent.');
    }
    if (logical.state === 'retired' && node.status !== 'retired' && node.status !== 'retiring') {
      throw new TypeError('Run progression retired node status is inconsistent.');
    }
  }
  return nodes;
};

const validateFactSources = (
  state: RunProgressionState,
  nodes: ReadonlyMap<string, RunNodeInstance>,
): void => {
  for (const value of state.values) {
    if (value.source.kind !== 'init' && !nodes.has(value.source.nodeKey)) {
      throw new TypeError('Run progression value source node is missing.');
    }
  }
  for (const resolution of state.gateResolutions) {
    if (!nodes.has(resolution.nodeKey)) {
      throw new TypeError('Run progression gate resolution node is missing.');
    }
  }
  for (const verdict of state.candidateVerdicts) {
    if (!nodes.has(verdict.nodeKey)) {
      throw new TypeError('Run progression candidate verdict node is missing.');
    }
  }
};

const terminalSelectionInvalid = (
  input: ConsistencyInput,
  nodes: ReadonlyMap<string, RunNodeInstance>,
): boolean => {
  const { receipt, run, state } = input;
  if (state.phase !== 'terminal' || receipt.outcome.kind !== 'terminal') return false;
  const selected = nodes.get(state.terminal.nodeKey);
  return (
    selected === undefined ||
    receipt.outcome.terminal.nodeKey !== state.terminal.nodeKey ||
    receipt.outcome.terminal.outcome !== state.terminal.outcome ||
    receipt.outcome.terminal.status !== run.status ||
    receipt.outcome.terminal.fault?.code !== run.terminalFault?.code ||
    receipt.outcome.terminal.fault?.message !== run.terminalFault?.message ||
    state.nodes.some(
      (node) =>
        node.state === 'retired' &&
        (node.terminal.nodeKey !== state.terminal.nodeKey ||
          node.terminal.outcome !== state.terminal.outcome),
    )
  );
};

const validateTerminal = (
  input: ConsistencyInput,
  nodes: ReadonlyMap<string, RunNodeInstance>,
): void => {
  const { receipt, run, state } = input;
  const terminalReceipt = receipt.outcome.kind === 'terminal';
  if (terminalReceipt !== (state.phase === 'terminal')) {
    throw new TypeError('Run progression receipt outcome is inconsistent.');
  }
  if (state.phase === 'terminal' && receipt.outcome.kind === 'terminal') {
    if (terminalSelectionInvalid(input, nodes)) {
      throw new TypeError('Run progression terminal selection is inconsistent.');
    }
  } else if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
    throw new TypeError('Waiting progression receipt has a terminal Run.');
  }
};

const expectedPrimaryKind = (
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

const validateReceiptHistory = (input: ConsistencyInput): void => {
  const { receipt, state } = input;
  for (const commandReceipt of state.commandReceipts) {
    if (commandReceipt.result.occurrenceKey !== state.occurrenceKey) {
      throw new TypeError('Run progression command receipt occurrence is inconsistent.');
    }
  }
  if (input.steps[0]?.kind !== expectedPrimaryKind(receipt.operation)) {
    throw new TypeError('Run progression step operation is inconsistent.');
  }

  if (receipt.operation === 'retired_attempt_observation') {
    if (
      input.steps.length !== 1 ||
      state.commandReceipts.length !== input.priorState.commandReceipts.length
    ) {
      throw new TypeError('Retired Attempt observation receipt is inconsistent.');
    }
    return;
  }

  const priorReceipts = input.priorState.commandReceipts;
  const nextReceipts = state.commandReceipts;
  const applied = nextReceipts.at(-1);
  if (
    nextReceipts.length !== priorReceipts.length + 1 ||
    canonicalizeJson(nextReceipts.slice(0, -1)) !== canonicalizeJson(priorReceipts) ||
    applied?.identity.operation !== receipt.operation ||
    canonicalizeJson(applied.result) !== canonicalizeJson(receipt)
  ) {
    throw new TypeError('Run progression applied command receipt is inconsistent.');
  }
};

export const validateRunProgressionConsistency = (input: ConsistencyInput): void => {
  validateOccurrence(input);
  const nodes = validateOperationalNodes(input);
  validateFactSources(input.state, nodes);
  validateTerminal(input, nodes);
  validateReceiptHistory(input);
};
