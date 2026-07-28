import { canonicalizeJson } from '../policy/index.js';
import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionState } from './run-progression-state.js';

const same = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

const appendOnly = (prior: readonly unknown[], next: readonly unknown[]): boolean =>
  next.length >= prior.length && same(next.slice(0, prior.length), prior);

export const validateRunProgressionHistory = (input: {
  readonly prior: RunProgressionState;
  readonly next: RunProgressionState;
  readonly receipt: RunProgressionAppliedReceipt;
  readonly steps: readonly RunProgressionIntentStep[];
}): void => {
  if (input.receipt.operation === 'initialize') {
    const command = input.next.commandReceipts.at(-1);
    const expectedValues =
      command?.semanticRequest.kind === 'initialize'
        ? command.semanticRequest.values.map((fact) => ({
            ...fact,
            source: { kind: 'init' },
          }))
        : null;
    if (
      input.prior.phase !== 'uninitialized' ||
      expectedValues === null ||
      !same(input.next.values, expectedValues)
    ) {
      throw new TypeError('Run progression initialization history is invalid.');
    }
    return;
  }
  if (
    input.prior.phase === 'uninitialized' ||
    input.prior.occurrenceKey !== input.next.occurrenceKey ||
    !appendOnly(input.prior.values, input.next.values)
  ) {
    throw new TypeError('Run progression value history is invalid.');
  }
  const command = input.next.commandReceipts.at(-1);
  const semanticRequest = command?.semanticRequest;
  const appendedValues = input.next.values.slice(input.prior.values.length);
  const expectedValues =
    semanticRequest?.kind === 'task_outcome' && semanticRequest.outcome.kind === 'succeeded'
      ? semanticRequest.outcome.values.map((fact) => ({
          ...fact,
          source: { kind: 'task_outcome', nodeKey: semanticRequest.nodeKey },
        }))
      : semanticRequest?.kind === 'human_gate_resolution'
        ? semanticRequest.values.map((fact) => ({
            ...fact,
            source: { kind: 'human_gate_resolution', nodeKey: semanticRequest.nodeKey },
          }))
        : [];
  if (!same(appendedValues, expectedValues)) {
    throw new TypeError('Run progression appended values are inconsistent.');
  }
  const verdictsValid =
    input.receipt.operation === 'consensus_verdict'
      ? appendOnly(input.prior.candidateVerdicts, input.next.candidateVerdicts) &&
        input.next.candidateVerdicts.length === input.prior.candidateVerdicts.length + 1 &&
        command?.semanticRequest.kind === 'consensus_verdict' &&
        same(input.next.candidateVerdicts.at(-1), {
          candidateKey: command.semanticRequest.candidateKey,
          nodeKey: command.semanticRequest.nodeKey,
          verdict: command.semanticRequest.verdict,
        })
      : same(input.prior.candidateVerdicts, input.next.candidateVerdicts);
  const gatesValid =
    input.receipt.operation === 'human_gate_resolution'
      ? appendOnly(input.prior.gateResolutions, input.next.gateResolutions) &&
        input.next.gateResolutions.length === input.prior.gateResolutions.length + 1 &&
        command?.semanticRequest.kind === 'human_gate_resolution' &&
        same(input.next.gateResolutions.at(-1), {
          nodeKey: command.semanticRequest.nodeKey,
          resolution: command.semanticRequest.resolution,
        })
      : same(input.prior.gateResolutions, input.next.gateResolutions);
  if (!verdictsValid || !gatesValid) {
    throw new TypeError('Run progression fact history is invalid.');
  }

  const mutableKeys = new Set<string>();
  for (const step of input.steps) {
    if (
      step.kind === 'complete_task' ||
      step.kind === 'resolve_gate' ||
      step.kind === 'complete_selector' ||
      step.kind === 'complete_join' ||
      step.kind === 'activate_node'
    ) {
      mutableKeys.add(step.nodeKey);
    }
    if (step.kind === 'terminate') {
      for (const retirement of step.retirements) mutableKeys.add(retirement.node.nodeKey);
    }
  }
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
