import {
  canonicalizeJson,
  snapshotRunProgressionAppliedReceipt,
  snapshotRunProgressionState,
} from '../policy/index.js';
import { createRun } from './create-run.js';
import { domainEvents } from './domain-events.js';
import type { DomainTransition } from './domain-transition.js';
import { materializeRunProgressionSteps } from './materialize-run-progression-steps.js';
import type { RunProgressionIntent } from './run-progression-intent.js';
import type { RunProgressionProjection } from './run-progression-projection.js';
import { validateRunAggregate } from './validate-run-aggregate.js';
import { validateRunProgressionConsistency } from './validate-run-progression-consistency.js';
import { validateRunProgressionHistory } from './validate-run-progression-history.js';
import { validateRunProgressionOutputs } from './validate-run-progression-outputs.js';
import { validateRunProgressionStepGrammar } from './validate-run-progression-step-grammar.js';
import { validateRunProgressionTaskOutcome } from './validate-run-progression-task-outcome.js';

const sameValue = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

export const applyRunProgression = (input: {
  readonly projection: RunProgressionProjection;
  readonly intent: RunProgressionIntent;
  readonly transactionNow: number;
}): DomainTransition => {
  const nextState = snapshotRunProgressionState(input.intent.nextState);
  const receipt = snapshotRunProgressionAppliedReceipt(input.intent.receipt);
  if (
    !Number.isSafeInteger(input.transactionNow) ||
    input.transactionNow < 0 ||
    !sameValue(receipt, input.intent.receipt)
  ) {
    throw new TypeError('Run progression transition is invalid.');
  }
  const cleanup = receipt.operation === 'retired_attempt_observation';
  validateRunProgressionStepGrammar({
    projection: input.projection,
    receipt,
    steps: input.intent.steps,
  });
  validateRunProgressionHistory({
    next: nextState,
    prior: input.projection.run.progression,
    receipt,
    steps: input.intent.steps,
  });
  validateRunProgressionOutputs({
    runId: input.projection.run.id,
    state: nextState,
    steps: input.intent.steps,
    transactionNow: input.transactionNow,
  });
  validateRunProgressionTaskOutcome({
    receipt: nextState.commandReceipts.at(-1),
    steps: input.intent.steps,
  });
  const materialized = materializeRunProgressionSteps({
    projection: input.projection,
    receipt,
    state: nextState,
    steps: input.intent.steps,
    transactionNow: input.transactionNow,
  });
  const terminal = receipt.outcome.kind === 'terminal' ? receipt.outcome.terminal : null;
  const run = cleanup
    ? input.projection.run
    : createRun({
        ...input.projection.run,
        createdAt:
          input.projection.run.progression.phase === 'uninitialized'
            ? input.transactionNow
            : input.projection.run.createdAt,
        progression: nextState,
        revision:
          input.projection.run.progression.phase === 'uninitialized'
            ? 0
            : input.projection.run.revision + 1,
        status: terminal?.status ?? input.projection.run.status,
        terminalAt: terminal === null ? null : input.transactionNow,
        terminalFault: terminal?.fault ?? null,
        updatedAt: input.transactionNow,
      });
  const eventIntents =
    !cleanup && terminal !== null
      ? Object.freeze([...materialized.eventIntents, domainEvents.terminalized(run, terminal)])
      : materialized.eventIntents;
  if (cleanup) {
    if (
      materialized.outputs.length !== 0 ||
      eventIntents.length !== 0 ||
      !sameValue(nextState, input.projection.run.progression)
    ) {
      throw new TypeError('Retired Attempt observation may change only physical authority.');
    }
  }

  const replace = <Value extends { readonly id: string }>(
    prior: readonly Value[],
    delta: readonly Value[],
  ): readonly Value[] => {
    const updates = new Map(delta.map((value) => [value.id, value]));
    const result = prior.map((value) => updates.get(value.id) ?? value);
    const priorIds = new Set(prior.map((value) => value.id));
    result.push(...delta.filter((value) => !priorIds.has(value.id)));
    return result;
  };
  const aggregateNodes = replace(input.projection.nodes, materialized.nodes);
  const aggregateAttempts = replace(input.projection.attempts, materialized.attempts);
  validateRunAggregate({
    attempts: aggregateAttempts,
    nodes: aggregateNodes,
    run,
  });
  validateRunProgressionConsistency({
    nodes: aggregateNodes,
    priorState: input.projection.run.progression,
    receipt,
    run,
    state: nextState,
    steps: input.intent.steps,
  });
  return Object.freeze({
    attempts: materialized.attempts,
    changed: true,
    eventIntents,
    nodes: materialized.nodes,
    outputs: materialized.outputs,
    run,
  });
};
