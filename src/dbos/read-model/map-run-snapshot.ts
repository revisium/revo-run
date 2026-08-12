import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { RunError, RunSnapshot, RunStatus, RunSummary } from '../../contracts/run/run.js';
import type { RunWorkflowInput } from '../../contracts/workflow/run-workflow-input.js';
import { parseDbosWorkflowStatus } from '../../validation/dbos-workflow-status.validator.js';
import {
  parseRunWorkflowInput,
  parseRunWorkflowResult,
} from '../../validation/parse-run-workflow-data.js';
import { isValidRunId } from '../../validation/run-id.validator.js';
import { runWorkflowId } from '../workflow-id.js';

const workflowIdPrefix = 'rr:run:v1:';

export const mapRunStatus = (status: string): RunStatus => {
  switch (status) {
    case 'ENQUEUED':
    case 'DELAYED':
      return 'pending';
    case 'PENDING':
      return 'running';
    case 'SUCCESS':
      return 'succeeded';
    case 'CANCELLED':
      return 'cancelled';
    case 'ERROR':
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
      return 'failed';
    default:
      throw new Error(`Unknown DBOS workflow status: ${status}.`);
  }
};

const mapError = (status: WorkflowStatus): RunError | undefined => {
  if (status.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED') {
    return {
      code: 'recovery_exhausted',
      message: 'Workflow recovery attempts were exhausted.',
    };
  }
  if (status.status === 'ERROR') {
    return {
      code: 'workflow_failed',
      message: 'Workflow execution failed.',
    };
  }
  return undefined;
};

const epoch = (value: number | undefined, fallback?: number): number => {
  const resolved = value ?? fallback;
  if (resolved === undefined || !Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error('DBOS workflow timestamp is invalid.');
  }
  return resolved;
};

const timestamps = (
  status: WorkflowStatus,
): { readonly createdAt: Date; readonly updatedAt: Date } => {
  const createdAt = epoch(status.createdAt);
  const updatedAt = epoch(status.updatedAt, createdAt);
  if (updatedAt < createdAt) {
    throw new Error('DBOS workflow timestamps are inverted.');
  }
  if (status.completedAt !== undefined) {
    const completedAt = epoch(status.completedAt);
    if (completedAt < createdAt || completedAt > updatedAt) {
      throw new Error('DBOS workflow completion timestamp is inverted.');
    }
  }
  return { createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) };
};

const runIdFromWorkflowId = (workflowId: string): string => {
  if (!workflowId.startsWith(workflowIdPrefix)) {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }
  const runId = workflowId.slice(workflowIdPrefix.length);
  if (!isValidRunId(runId)) {
    throw new Error('Owned run workflow ID is invalid.');
  }
  return runId;
};

const ownedInput = (
  status: WorkflowStatus,
  workflowName: string,
  expectedRunId?: string,
): { readonly runId: string; readonly input: RunWorkflowInput } => {
  if (status.workflowName !== workflowName) {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }
  const runId = runIdFromWorkflowId(status.workflowID);
  if (expectedRunId !== undefined && runId !== expectedRunId) {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }

  const input = parseRunWorkflowInput(status.input);
  if (input.runId !== runId) {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }
  return { runId, input };
};

const summaryFrom = (status: WorkflowStatus, runId: string): RunSummary => {
  const base = { id: runId, ...timestamps(status) };
  if (status.status === 'SUCCESS') {
    const result = parseRunWorkflowResult(status.output);
    const mappedResult = {
      outcome: result.outcome,
      ...(result.output === undefined ? {} : { output: result.output }),
    };
    switch (result.status) {
      case 'succeeded':
        return { ...base, status: 'succeeded', result: mappedResult };
      case 'failed':
        return { ...base, status: 'failed', result: mappedResult };
      case 'cancelled':
        return { ...base, status: 'cancelled', result: mappedResult };
    }
  }
  if (status.status === 'CANCELLED') {
    if (status.output === undefined) {
      return { ...base, status: 'cancelled' };
    }
    const result = parseRunWorkflowResult(status.output);
    if (result.status !== 'cancelled') {
      throw new Error('Cancelled DBOS workflow output has a different status.');
    }
    return {
      ...base,
      status: 'cancelled',
      result: {
        outcome: result.outcome,
        ...(result.output === undefined ? {} : { output: result.output }),
      },
    };
  }

  const error = mapError(status);
  if (error !== undefined) {
    return { ...base, status: 'failed', error };
  }
  if (status.output !== undefined) {
    throw new Error('Non-terminal DBOS workflow has an output.');
  }
  const mappedStatus = mapRunStatus(status.status);
  if (mappedStatus === 'pending' || mappedStatus === 'running') {
    return { ...base, status: mappedStatus };
  }
  throw new Error('Terminal DBOS workflow is missing its terminal data.');
};

export class RunOwnershipError extends Error {}

export const mapRunSummary = (status: WorkflowStatus, workflowName: string): RunSummary => {
  const parsed = parseDbosWorkflowStatus(status);
  const { runId } = ownedInput(parsed, workflowName);
  return summaryFrom(parsed, runId);
};

export const mapRunSnapshot = (
  status: WorkflowStatus,
  workflowName: string,
  runId: string,
): RunSnapshot => {
  const parsed = parseDbosWorkflowStatus(status);
  if (parsed.workflowID !== runWorkflowId(runId)) {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }
  const { input } = ownedInput(parsed, workflowName, runId);
  return { ...summaryFrom(parsed, runId), executionPlan: input.executionPlan, input: input.input };
};
