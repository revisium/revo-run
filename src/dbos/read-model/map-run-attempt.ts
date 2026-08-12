import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunAttempt } from '../../contracts/run/run-details.js';
import { createAttemptId } from '../../pipeline/identity/execution-identity.js';
import { parseRunNodeExecution } from '../../validation/run-node-execution.validator.js';
import {
  parseRunNodeEffectDecision,
  parseRunNodeReconciliation,
} from '../../validation/run-node-recovery.validator.js';
import {
  isNodeEffectDecisionStepName,
  isNodeReconciliationStepName,
  nodeReconciliationStepIdentity,
} from '../dbos-names.js';
import { isDbosStepTimeout } from '../steps/step-timeout.js';
import type { DbosStepRecord } from './dbos-step-pages.js';
import type { ObservableNodeCandidate } from './observable-plan.js';

const attemptTimestamps = (
  step: DbosStepRecord,
): { readonly startedAt?: Date; readonly completedAt?: Date } => ({
  ...(step.startedAtEpochMs === undefined ? {} : { startedAt: new Date(step.startedAtEpochMs) }),
  ...(step.completedAtEpochMs === undefined
    ? {}
    : { completedAt: new Date(step.completedAtEpochMs) }),
});

const assertStoredExecutionIdentity = (
  request: RunExecutorRequest,
  candidate: ObservableNodeCandidate,
  runId: string,
  attemptOrdinal: number,
): void => {
  const attemptId = createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal });
  if (
    request.runId !== runId ||
    request.scopeId !== candidate.scopeId ||
    request.authoredNodeId !== candidate.authoredNodeId ||
    request.nodeInstanceId !== candidate.id ||
    request.attemptId !== attemptId ||
    request.attemptOrdinal !== attemptOrdinal ||
    request.pipelineId !== candidate.pipelineId ||
    request.nodePath !== candidate.nodePath ||
    request.displayPath !== candidate.displayPath
  ) {
    throw new Error('Stored node execution identity is invalid.');
  }
};

const mapErroredAttempt = (
  step: DbosStepRecord,
  candidate: ObservableNodeCandidate,
  attemptId: RunAttempt['id'],
  attemptOrdinal: number,
  timestamps: { readonly startedAt?: Date; readonly completedAt?: Date },
): RunAttempt | undefined => {
  if (!(step.error instanceof Error)) {
    throw new Error('DBOS node step error is invalid.');
  }
  if (isNodeReconciliationStepName(step.name)) {
    return undefined;
  }

  return isDbosStepTimeout(step.error)
    ? {
        id: attemptId,
        nodeInstanceId: candidate.id,
        ordinal: attemptOrdinal,
        status: 'timedOut',
        ...timestamps,
      }
    : {
        id: attemptId,
        nodeInstanceId: candidate.id,
        ordinal: attemptOrdinal,
        status: 'failed',
        error: { code: 'step_failed' },
        ...timestamps,
      };
};

const mapEffectDecisionAttempt = (
  step: DbosStepRecord,
  candidate: ObservableNodeCandidate,
  runId: string,
  attemptOrdinal: number,
  timestamps: { readonly startedAt?: Date; readonly completedAt?: Date },
): RunAttempt | undefined => {
  const decision = parseRunNodeEffectDecision(step.output);
  if (decision.kind === 'mustReconcile') {
    assertStoredExecutionIdentity(decision.request, candidate, runId, attemptOrdinal);
    return undefined;
  }
  return mapExecution(decision, candidate, runId, attemptOrdinal, timestamps);
};

const mapReconciledAttempt = (
  step: DbosStepRecord,
  candidate: ObservableNodeCandidate,
  runId: string,
  attemptOrdinal: number,
  timestamps: { readonly startedAt?: Date; readonly completedAt?: Date },
): RunAttempt | undefined => {
  const stepIdentity = nodeReconciliationStepIdentity(step.name);
  const reconciliation = parseRunNodeReconciliation(step.output);
  assertStoredExecutionIdentity(reconciliation.request, candidate, runId, attemptOrdinal);
  if (stepIdentity.reconciliationRound !== reconciliation.reconciliationRound) {
    throw new Error('Stored node reconciliation round is invalid.');
  }
  if (reconciliation.kind === 'reconciliationFailed') {
    return undefined;
  }

  switch (reconciliation.result.kind) {
    case 'effectCompleted':
      return mapExecution(
        {
          kind: 'runNodeExecution',
          request: reconciliation.request,
          result: reconciliation.result.result,
        },
        candidate,
        runId,
        attemptOrdinal,
        timestamps,
      );
    case 'effectFailed':
      return mapExecution(
        {
          kind: 'runNodeExecution',
          request: reconciliation.request,
          result: { kind: 'failed', error: reconciliation.result.error },
        },
        candidate,
        runId,
        attemptOrdinal,
        timestamps,
      );
    case 'effectNotFound':
      return {
        id: createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal }),
        nodeInstanceId: candidate.id,
        ordinal: attemptOrdinal,
        status: 'failed',
        error: { code: 'effect_not_found' },
        ...timestamps,
      };
    case 'outcomeUnknown':
      return {
        id: createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal }),
        nodeInstanceId: candidate.id,
        ordinal: attemptOrdinal,
        status: 'outcomeUnknown',
        recovery: { reconciliationRound: reconciliation.reconciliationRound },
        ...timestamps,
      };
  }
  throw new Error('DBOS node attempt outcome step is unsupported.');
};

export const mapRunAttempt = (
  step: DbosStepRecord,
  candidate: ObservableNodeCandidate,
  runId: string,
  attemptOrdinal: number,
): RunAttempt | undefined => {
  const timestamps = attemptTimestamps(step);
  const attemptId = createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal });
  if (step.error !== null) {
    return mapErroredAttempt(step, candidate, attemptId, attemptOrdinal, timestamps);
  }

  if (isNodeEffectDecisionStepName(step.name)) {
    return mapEffectDecisionAttempt(step, candidate, runId, attemptOrdinal, timestamps);
  }
  if (isNodeReconciliationStepName(step.name)) {
    return mapReconciledAttempt(step, candidate, runId, attemptOrdinal, timestamps);
  }
  throw new Error('DBOS node attempt outcome step is unsupported.');
};

const mapExecution = (
  execution: ReturnType<typeof parseRunNodeExecution>,
  candidate: ObservableNodeCandidate,
  runId: string,
  attemptOrdinal: number,
  timestamps: { readonly startedAt?: Date; readonly completedAt?: Date },
): RunAttempt => {
  assertStoredExecutionIdentity(execution.request, candidate, runId, attemptOrdinal);
  const attemptId = createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal });
  if (execution.result.kind === 'completed') {
    return {
      id: attemptId,
      nodeInstanceId: candidate.id,
      ordinal: attemptOrdinal,
      status: 'completed',
      outcome: execution.result.outcome,
      ...(execution.result.output === undefined ? {} : { output: execution.result.output }),
      ...timestamps,
    };
  }
  return {
    id: attemptId,
    nodeInstanceId: candidate.id,
    ordinal: attemptOrdinal,
    status: 'failed',
    error: { code: execution.result.error.code },
    ...timestamps,
  };
};
