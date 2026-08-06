import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { RunError, RunSnapshot, RunStatus } from '../../contracts/run/run.js';
import {
  parseRunWorkflowInput,
  parseRunWorkflowResult,
} from '../../validation/parse-run-workflow-data.js';

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

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Workflow execution failed.';
};

const mapError = (status: WorkflowStatus): RunError | undefined => {
  if (status.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED') {
    return {
      code: 'recovery_exhausted',
      message: errorMessage(status.error),
    };
  }
  if (status.status === 'ERROR') {
    return {
      code: 'workflow_failed',
      message: errorMessage(status.error),
    };
  }
  return undefined;
};

export const mapRunSnapshot = (status: WorkflowStatus, workflowName: string): RunSnapshot => {
  if (status.workflowName !== workflowName) {
    throw new Error('Workflow is not a Revo run.');
  }

  const { executionPlan, input } = parseRunWorkflowInput(status.input);
  const snapshot = {
    id: status.workflowID,
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
