import { canonicalizeJson } from '../policy/index.js';
import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionState } from './run-progression-state.js';

const same = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const appendOnly = (prior: readonly unknown[], next: readonly unknown[]): boolean =>
  next.length >= prior.length && same(next.slice(0, prior.length), prior);

type HistoryInput = {
  readonly prior: RunProgressionState;
  readonly next: RunProgressionState;
  readonly receipt: RunProgressionAppliedReceipt;
  readonly steps: readonly RunProgressionIntentStep[];
};

const validateInitialization = (input: HistoryInput): void => {
  const command = input.next.commandReceipts.at(-1);
  const expectedValues =
    command?.semanticRequest.kind === 'initialize'
      ? command.semanticRequest.values.map((fact) => ({ ...fact, source: { kind: 'init' } }))
      : null;
  if (
    input.prior.phase !== 'uninitialized' ||
    expectedValues === null ||
    !same(input.next.values, expectedValues)
  ) {
    throw new TypeError('Run progression initialization history is invalid.');
  }
};

const expectedAppendedValues = (state: RunProgressionState): readonly unknown[] => {
  const request = state.commandReceipts.at(-1)?.semanticRequest;
  if (request?.kind === 'task_outcome' && request.outcome.kind === 'succeeded') {
    return request.outcome.values.map((fact) => ({
      ...fact,
      source: { kind: 'task_outcome', nodeKey: request.nodeKey },
    }));
  }
  if (request?.kind === 'human_gate_resolution') {
    return request.values.map((fact) => ({
      ...fact,
      source: { kind: 'human_gate_resolution', nodeKey: request.nodeKey },
    }));
  }
  return [];
};

const validateFacts = (input: HistoryInput): void => {
  const command = input.next.commandReceipts.at(-1);
  const verdictsUnchanged = same(input.prior.candidateVerdicts, input.next.candidateVerdicts);
  const verdictAppended =
    appendOnly(input.prior.candidateVerdicts, input.next.candidateVerdicts) &&
    input.next.candidateVerdicts.length === input.prior.candidateVerdicts.length + 1 &&
    command?.semanticRequest.kind === 'consensus_verdict' &&
    same(input.next.candidateVerdicts.at(-1), {
      candidateKey: command.semanticRequest.candidateKey,
      nodeKey: command.semanticRequest.nodeKey,
      verdict: command.semanticRequest.verdict,
    });
  const gatesUnchanged = same(input.prior.gateResolutions, input.next.gateResolutions);
  const gateAppended =
    appendOnly(input.prior.gateResolutions, input.next.gateResolutions) &&
    input.next.gateResolutions.length === input.prior.gateResolutions.length + 1 &&
    command?.semanticRequest.kind === 'human_gate_resolution' &&
    same(input.next.gateResolutions.at(-1), {
      nodeKey: command.semanticRequest.nodeKey,
      resolution: command.semanticRequest.resolution,
    });
  const verdictsValid =
    input.receipt.operation === 'consensus_verdict' ? verdictAppended : verdictsUnchanged;
  const gatesValid =
    input.receipt.operation === 'human_gate_resolution' ? gateAppended : gatesUnchanged;
  if (!verdictsValid || !gatesValid) {
    throw new TypeError('Run progression fact history is invalid.');
  }
};

const mutableNodeKeys = (steps: readonly RunProgressionIntentStep[]): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const step of steps) {
    if (
      step.kind === 'complete_task' ||
      step.kind === 'complete_selector' ||
      step.kind === 'complete_join' ||
      step.kind === 'resolve_gate' ||
      step.kind === 'activate_node'
    ) {
      keys.add(step.nodeKey);
    }
    if (step.kind === 'terminate') {
      for (const retirement of step.retirements) keys.add(retirement.node.nodeKey);
    }
  }
  return keys;
};

const validateNodes = (input: HistoryInput): void => {
  const mutableKeys = mutableNodeKeys(input.steps);
  for (const priorNode of input.prior.nodes) {
    const nextNode = input.next.nodes.find((node) => node.nodeKey === priorNode.nodeKey);
    if (
      nextNode === undefined ||
      (!mutableKeys.has(priorNode.nodeKey) && !same(priorNode, nextNode))
    ) {
      throw new TypeError('Run progression node history is invalid.');
    }
  }
};

export const validateRunProgressionHistory = (input: {
  readonly prior: RunProgressionState;
  readonly next: RunProgressionState;
  readonly receipt: RunProgressionAppliedReceipt;
  readonly steps: readonly RunProgressionIntentStep[];
}): void => {
  if (input.receipt.operation === 'initialize') {
    validateInitialization(input);
    return;
  }
  if (
    input.prior.phase === 'uninitialized' ||
    input.prior.occurrenceKey !== input.next.occurrenceKey ||
    !appendOnly(input.prior.values, input.next.values)
  ) {
    throw new TypeError('Run progression value history is invalid.');
  }
  const appendedValues = input.next.values.slice(input.prior.values.length);
  if (!same(appendedValues, expectedAppendedValues(input.next))) {
    throw new TypeError('Run progression appended values are inconsistent.');
  }
  validateFacts(input);
  validateNodes(input);
};
