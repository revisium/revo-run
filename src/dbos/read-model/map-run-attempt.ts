import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunAttempt } from '../../contracts/run/run-details.js';
import { createAttemptId } from '../../pipeline/identity/execution-identity.js';
import { parseRunNodeExecution } from '../../validation/run-node-execution.validator.js';
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

export const mapRunAttempt = (
  step: DbosStepRecord,
  candidate: ObservableNodeCandidate,
  runId: string,
  attemptOrdinal: number,
): RunAttempt => {
  const timestamps = attemptTimestamps(step);
  const attemptId = createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal });
  if (step.error !== null) {
    if (!(step.error instanceof Error)) {
      throw new Error('DBOS node step error is invalid.');
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
  }

  const execution = parseRunNodeExecution(step.output);
  assertStoredExecutionIdentity(execution.request, candidate, runId, attemptOrdinal);
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
