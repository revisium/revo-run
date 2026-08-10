import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { RunError, RunSnapshot, RunStatus } from '../../contracts/run/run.js';
import {
  parseRunWorkflowInput,
  parseRunWorkflowResult,
} from '../../validation/parse-run-workflow-data.js';
import { runWorkflowId } from '../workflow-id.js';

const mapStatus = (status: string): RunStatus => {
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

export class RunOwnershipError extends Error {}

export const mapRunSnapshot = (
  status: WorkflowStatus,
  workflowName: string,
  runId: string,
): RunSnapshot => {
  if (status.workflowName !== workflowName || status.workflowID !== runWorkflowId(runId)) {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }

  let durableInput;
  try {
    durableInput = parseRunWorkflowInput(status.input);
  } catch {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }
  if (durableInput.runId !== runId) {
    throw new RunOwnershipError('Workflow is not a Revo run.');
  }
  const { executionPlan, input } = durableInput;
  const snapshot = {
    id: runId,
    status: mapStatus(status.status),
    executionPlan,
    input,
    createdAt: new Date(status.createdAt),
    updatedAt: new Date(status.updatedAt ?? status.createdAt),
  };

  if (status.status === 'SUCCESS') {
    const result = parseRunWorkflowResult(status.output);
    return {
      ...snapshot,
      status: result.status,
      result: {
        outcome: result.outcome,
        ...(result.output === undefined ? {} : { output: result.output }),
      },
    };
  }

  const error = mapError(status);
  if (error !== undefined) {
    return { ...snapshot, error };
  }

  return snapshot;
};
