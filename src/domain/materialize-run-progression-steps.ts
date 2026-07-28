import { canonicalizeJson } from '../policy/index.js';
import type { Attempt } from './attempt.js';
import { createAttempt } from './create-attempt.js';
import { createRunNodeInstance } from './create-run-node-instance.js';
import { createRunOutput } from './create-run-output.js';
import { deriveRunProgressionAttemptEvent } from './derive-run-progression-attempt-event.js';
import { domainEvents } from './domain-events.js';
import type { RunEventIntent } from './run-event-intent.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';
import type { RunProgressionAppliedReceipt } from './run-progression-applied-receipt.js';
import { createRunProgressionDraft } from './run-progression-draft.js';
import type { RunProgressionIntentStep } from './run-progression-intent-step.js';
import type { RunProgressionProjection } from './run-progression-projection.js';
import type { RunProgressionState } from './run-progression-state.js';
import { validateRunProgressionActivation } from './validate-run-progression-activation.js';
import { validateRunProgressionAttemptDelta } from './validate-run-progression-attempt-delta.js';
import { validateRunProgressionNodeDelta } from './validate-run-progression-node-delta.js';
import { validateRunProgressionRetirement } from './validate-run-progression-retirement.js';

type MaterializedSteps = {
  readonly nodes: readonly RunNodeInstance[];
  readonly attempts: readonly Attempt[];
  readonly outputs: readonly RunOutput[];
  readonly eventIntents: readonly RunEventIntent[];
};

const stateNode = (state: RunProgressionState, nodeKey: string) =>
  state.nodes.find((node) => node.nodeKey === nodeKey);

export const materializeRunProgressionSteps = (input: {
  readonly projection: RunProgressionProjection;
  readonly state: RunProgressionState;
  readonly steps: readonly RunProgressionIntentStep[];
  readonly receipt: RunProgressionAppliedReceipt;
  readonly transactionNow: number;
}): MaterializedSteps => {
  const draft = createRunProgressionDraft(input.projection);
  const eventIntents: RunEventIntent[] = [];
  let initializeCount = 0;
  for (const step of input.steps) {
    if (step.kind === 'initialize') {
      initializeCount += 1;
      continue;
    }
    if (step.kind === 'record_verdict') {
      if (
        !input.state.candidateVerdicts.some(
          (item) => item.nodeKey === step.nodeKey && item.candidateKey === step.candidateKey,
        )
      ) {
        throw new TypeError('Run progression verdict step is invalid.');
      }
      continue;
    }
    if (step.kind === 'activate_node') {
      const node = createRunNodeInstance(step.node);
      validateRunProgressionActivation({
        node,
        projection: draft.projection(),
        step,
        transactionNow: input.transactionNow,
      });
      if (stateNode(input.state, step.nodeKey) === undefined) {
        throw new TypeError('Run progression activation state is invalid.');
      }
      draft.recordNode(node);
      eventIntents.push(domainEvents.activated(node));
      continue;
    }
    if (step.kind === 'complete_task') {
      const node = createRunNodeInstance(step.node);
      validateRunProgressionNodeDelta({
        node,
        nodeKey: step.nodeKey,
        projection: draft.projection(),
        transactionNow: input.transactionNow,
      });
      const logical = stateNode(input.state, step.nodeKey);
      if (
        logical?.state !== 'terminal' ||
        logical.outcome !== step.outcome ||
        (node.status !== 'succeeded' &&
          node.status !== 'failed' &&
          node.status !== 'cancelled' &&
          node.status !== 'skipped')
      ) {
        throw new TypeError('Run progression task completion is invalid.');
      }
      const priorNode = draft.projection().nodes.find((candidate) => candidate.id === node.id);
      if (priorNode === undefined) throw new TypeError('Run progression task node is missing.');
      if (step.attempt !== null) {
        const attempt = createAttempt(step.attempt);
        if (attempt.nodeInstanceId !== node.id || attempt.runId !== node.runId) {
          throw new TypeError('Run progression task Attempt is invalid.');
        }
        const priorAttempt = draft
          .projection()
          .attempts.find((candidate) => candidate.id === attempt.id);
        if (priorAttempt === undefined) {
          throw new TypeError('Run progression task Attempt is missing.');
        }
        validateRunProgressionAttemptDelta({
          allowFaultChange: true,
          next: attempt,
          prior: priorAttempt,
          transactionNow: input.transactionNow,
        });
        const attemptEvent = deriveRunProgressionAttemptEvent({
          next: attempt,
          node,
          prior: priorAttempt,
        });
        if (attemptEvent !== null) eventIntents.push(attemptEvent);
        draft.recordAttempt(attempt);
      }
      for (const value of step.outputs) {
        const output = createRunOutput(value);
        if (output.runId !== input.projection.run.id) {
          throw new TypeError('Run progression output is invalid.');
        }
        draft.recordOutput(output);
        eventIntents.push(domainEvents.outputRecorded(output));
      }
      eventIntents.push(
        domainEvents.nodeTransitioned(node, priorNode.status, 'pipeline_progression'),
      );
      draft.recordNode(node);
      continue;
    }
    if (
      step.kind === 'resolve_gate' ||
      step.kind === 'complete_selector' ||
      step.kind === 'complete_join'
    ) {
      const node = createRunNodeInstance(step.node);
      validateRunProgressionNodeDelta({
        node,
        nodeKey: step.nodeKey,
        projection: draft.projection(),
        transactionNow: input.transactionNow,
      });
      const logical = stateNode(input.state, step.nodeKey);
      if (
        node.status !== 'succeeded' ||
        logical?.state !== 'terminal' ||
        ((step.kind === 'complete_selector' || step.kind === 'complete_join') &&
          logical.outcome !== step.outcome) ||
        (step.kind === 'resolve_gate' &&
          !input.state.gateResolutions.some((item) => item.nodeKey === step.nodeKey))
      ) {
        throw new TypeError('Run progression waiting-node completion is invalid.');
      }
      const priorNode = draft.projection().nodes.find((candidate) => candidate.id === node.id);
      if (priorNode === undefined) throw new TypeError('Run progression waiting node is missing.');
      if (step.kind === 'resolve_gate') {
        const output = createRunOutput(step.output);
        draft.recordOutput(output);
        eventIntents.push(domainEvents.outputRecorded(output));
      }
      eventIntents.push(
        domainEvents.nodeTransitioned(node, priorNode.status, 'pipeline_progression'),
      );
      draft.recordNode(node);
      continue;
    }
    if (step.kind === 'terminate') {
      if (
        input.state.phase !== 'terminal' ||
        input.state.terminal.nodeKey !== step.nodeKey ||
        input.state.terminal.outcome !== step.outcome
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
          projection: draft.projection(),
          transactionNow: input.transactionNow,
        });
        const priorNode = draft.projection().nodes.find((candidate) => candidate.id === node.id);
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
            projection: draft.projection(),
            transactionNow: input.transactionNow,
          });
          const priorAttempt = draft
            .projection()
            .attempts.find((candidate) => candidate.id === attempt.id);
          if (priorAttempt === undefined) {
            throw new TypeError('Run progression retirement Attempt is missing.');
          }
          validateRunProgressionAttemptDelta({
            next: attempt,
            prior: priorAttempt,
            transactionNow: input.transactionNow,
          });
          const attemptEvent = deriveRunProgressionAttemptEvent({
            next: attempt,
            node,
            prior: priorAttempt,
          });
          if (attemptEvent !== null) eventIntents.push(attemptEvent);
          draft.recordAttempt(attempt);
        } else {
          validateRunProgressionRetirement({
            attempt: null,
            node,
            projection: draft.projection(),
            transactionNow: input.transactionNow,
          });
        }
        eventIntents.push(
          domainEvents.nodeTransitioned(node, priorNode.status, 'pipeline_retirement'),
        );
        draft.recordNode(node);
      }
      continue;
    }
    const node = createRunNodeInstance(step.node);
    const attempt = createAttempt(step.attempt);
    const priorNode = draft
      .projection()
      .nodes.find((candidate) => candidate.nodeKey === step.nodeKey);
    const priorAttempt = draft
      .projection()
      .attempts.find((candidate) => candidate.id === step.attemptId);
    if (
      priorNode?.status !== 'retiring' ||
      priorAttempt === undefined ||
      priorAttempt.progressionClosedAt === null ||
      node.status !== 'retired' ||
      attempt.id !== step.attemptId ||
      canonicalizeJson(input.state) !== canonicalizeJson(input.projection.run.progression)
    ) {
      throw new TypeError('Run progression retired Attempt settlement is invalid.');
    }
    const observation =
      input.receipt.operation === 'retired_attempt_observation'
        ? input.receipt.attemptObservation
        : null;
    if (
      observation == null ||
      observation.attemptId !== attempt.id ||
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
      transactionNow: input.transactionNow,
    });
    validateRunProgressionNodeDelta({
      node,
      nodeKey: step.nodeKey,
      projection: draft.projection(),
      transactionNow: input.transactionNow,
    });
    draft.recordNode(node);
    draft.recordAttempt(attempt);
  }
  if (initializeCount > 1 || (initializeCount === 1 && input.steps[0]?.kind !== 'initialize')) {
    throw new TypeError('Run progression initialization order is invalid.');
  }
  return Object.freeze({
    attempts: draft.attemptDeltas(),
    eventIntents: Object.freeze(eventIntents),
    nodes: draft.nodeDeltas(),
    outputs: draft.outputDeltas(),
  });
};
