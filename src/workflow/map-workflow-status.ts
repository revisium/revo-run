import type { JsonValue } from '@revisium/revo-pipeline';

import { snapshotExecutionPlan, snapshotRunInput } from '../manager/snapshot-run-input.js';
import {
  normalizeExecutionFailureMessage,
  RUN_TERMINAL_ENVELOPE,
  type RunTerminalEnvelope,
} from '../pipeline/interpret-pipeline.js';
import type { RunErrorCode, RunSnapshot } from '../types.js';
import { RUN_WORKFLOW_NAME } from './register-workflows.js';

interface WorkflowStatusRecord {
  readonly workflowID: string;
  readonly workflowName: string;
  readonly status: string;
  readonly input?: unknown[];
  readonly output?: unknown;
  readonly createdAt: number;
  readonly updatedAt?: number;
}

const errorMessage = (code: RunErrorCode): string => {
  switch (code) {
    case 'execution_failed':
      return 'Run execution failed.';
    case 'workflow_failed':
      return 'Run workflow failed.';
    case 'recovery_exhausted':
      return 'Run workflow exhausted recovery attempts.';
    case 'invalid_workflow_state':
      return 'Run workflow state is invalid.';
  }
  throw new Error('Unknown run error code.');
};

const failure = (
  snapshot: Omit<RunSnapshot, 'status' | 'error'>,
  code: RunErrorCode,
  message = errorMessage(code),
): RunSnapshot => ({
  ...snapshot,
  status: 'failed',
  error: { code, message },
});

const parseTerminalEnvelope = (value: unknown): RunTerminalEnvelope | undefined => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== RUN_TERMINAL_ENVELOPE ||
    !('status' in value)
  ) {
    return undefined;
  }
  if (value.status === 'cancelled') {
    return { kind: RUN_TERMINAL_ENVELOPE, status: 'cancelled' };
  }
  if (value.status === 'succeeded' && 'result' in value) {
    try {
      return {
        kind: RUN_TERMINAL_ENVELOPE,
        status: 'succeeded',
        result: snapshotRunInput(value.result),
      };
    } catch {
      return undefined;
    }
  }
  if (
    value.status !== 'failed' ||
    !('error' in value) ||
    typeof value.error !== 'object' ||
    value.error === null ||
    !('code' in value.error)
  ) {
    return undefined;
  }
  if (value.error.code === 'invalid_workflow_state') {
    return {
      error: { code: 'invalid_workflow_state' },
      kind: RUN_TERMINAL_ENVELOPE,
      status: 'failed',
    };
  }
  if (value.error.code === 'execution_failed' && 'message' in value.error) {
    const message = normalizeExecutionFailureMessage(value.error.message);
    if (message !== undefined) {
      return {
        error: { code: 'execution_failed', message },
        kind: RUN_TERMINAL_ENVELOPE,
        status: 'failed',
      };
    }
  }
  return undefined;
};

const toDate = (value: number | undefined): Date | undefined => {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const mapWorkflowStatus = (status: WorkflowStatusRecord): RunSnapshot | undefined => {
  if (status.workflowName !== RUN_WORKFLOW_NAME || status.input?.length !== 2) {
    return undefined;
  }
  let executionPlan;
  let input: JsonValue;
  try {
    executionPlan = snapshotExecutionPlan(status.input[0]);
    input = snapshotRunInput(status.input[1]);
  } catch {
    return undefined;
  }
  const createdAt = toDate(status.createdAt) ?? new Date(0);
  const base = {
    createdAt,
    executionPlan,
    id: status.workflowID,
    input,
    updatedAt: toDate(status.updatedAt) ?? createdAt,
  };
  if (createdAt.getTime() === 0 && status.createdAt !== 0) {
    return failure(base, 'invalid_workflow_state');
  }
  switch (status.status) {
    case 'ENQUEUED':
    case 'DELAYED':
      return { ...base, status: 'pending' };
    case 'PENDING':
      return { ...base, status: 'running' };
    case 'ERROR':
      return failure(base, 'workflow_failed');
    case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
      return failure(base, 'recovery_exhausted');
    case 'CANCELLED':
      return { ...base, status: 'cancelled' };
    case 'SUCCESS': {
      const envelope = parseTerminalEnvelope(status.output);
      if (envelope === undefined) {
        return failure(base, 'invalid_workflow_state');
      }
      if (envelope.status === 'cancelled') {
        return { ...base, status: 'cancelled' };
      }
      if (envelope.status === 'failed') {
        return failure(
          base,
          envelope.error.code,
          envelope.error.code === 'execution_failed' ? envelope.error.message : undefined,
        );
      }
      return { ...base, status: 'succeeded', result: envelope.result };
    }
    default:
      return failure(base, 'invalid_workflow_state');
  }
};
