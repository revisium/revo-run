import type { JsonValue } from '@revisium/revo-pipeline';

import { snapshotJsonValue } from '../json/snapshot-json.js';
import { snapshotExecutionPlan, snapshotRunInput } from '../manager/snapshot-run-input.js';
import {
  normalizeExecutionFailureMessage,
  RUN_TERMINAL_ENVELOPE,
  type RunTerminalEnvelope,
  type RunSuccessResult,
  type TaskOutput,
} from '../pipeline/interpret-pipeline.js';
import type { ExecutionPlan, RunErrorCode, RunSnapshot } from '../types.js';
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

type JsonRecord = Readonly<Record<string, JsonValue>>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: JsonRecord, expected: readonly string[]): boolean => {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === 'string')
  );
};

const parseTaskOutputs = (
  value: JsonValue | undefined,
  executionPlan: ExecutionPlan,
): readonly TaskOutput[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const outputs: TaskOutput[] = [];
  for (const entry of value) {
    if (!isJsonRecord(entry) || !hasExactKeys(entry, ['nodeKey', 'value'])) {
      return undefined;
    }
    const nodeKey = entry['nodeKey'];
    const output = entry['value'];
    if (typeof nodeKey !== 'string' || output === undefined || seen.has(nodeKey)) {
      return undefined;
    }
    const task = executionPlan.pipeline.nodes.find(
      (node) => node.key === nodeKey && node.kind === 'task',
    );
    if (task === undefined) {
      return undefined;
    }
    seen.add(nodeKey);
    outputs.push({ nodeKey: task.key, value: output });
  }
  return outputs;
};

const parseSuccessResult = (
  value: JsonValue | undefined,
  executionPlan: ExecutionPlan,
): RunSuccessResult | undefined => {
  if (!isJsonRecord(value) || typeof value['outcome'] !== 'string') {
    return undefined;
  }
  if (hasExactKeys(value, ['outcome'])) {
    return { outcome: value['outcome'] };
  }
  if (!hasExactKeys(value, ['outcome', 'outputs'])) {
    return undefined;
  }
  const outputs = parseTaskOutputs(value['outputs'], executionPlan);
  return outputs === undefined ? undefined : { outcome: value['outcome'], outputs };
};

const parseTerminalEnvelope = (
  value: unknown,
  executionPlan: ExecutionPlan,
): RunTerminalEnvelope | undefined => {
  let snapshot: JsonValue;
  try {
    snapshot = snapshotJsonValue(value, 'Workflow output');
  } catch {
    return undefined;
  }
  if (
    !isJsonRecord(snapshot) ||
    !Object.hasOwn(snapshot, 'kind') ||
    snapshot['kind'] !== RUN_TERMINAL_ENVELOPE ||
    !Object.hasOwn(snapshot, 'status')
  ) {
    return undefined;
  }
  if (snapshot['status'] === 'cancelled') {
    if (!hasExactKeys(snapshot, ['kind', 'status'])) {
      return undefined;
    }
    return { kind: RUN_TERMINAL_ENVELOPE, status: 'cancelled' };
  }
  if (snapshot['status'] === 'succeeded' && Object.hasOwn(snapshot, 'result')) {
    if (!hasExactKeys(snapshot, ['kind', 'result', 'status'])) {
      return undefined;
    }
    const result = parseSuccessResult(snapshot['result'], executionPlan);
    return result === undefined
      ? undefined
      : { kind: RUN_TERMINAL_ENVELOPE, status: 'succeeded', result };
  }
  if (
    snapshot['status'] !== 'failed' ||
    !hasExactKeys(snapshot, ['error', 'kind', 'status']) ||
    !Object.hasOwn(snapshot, 'error') ||
    !isJsonRecord(snapshot['error']) ||
    !Object.hasOwn(snapshot['error'], 'code')
  ) {
    return undefined;
  }
  const error = snapshot['error'];
  if (error['code'] === 'invalid_workflow_state' && hasExactKeys(error, ['code'])) {
    return {
      error: { code: 'invalid_workflow_state' },
      kind: RUN_TERMINAL_ENVELOPE,
      status: 'failed',
    };
  }
  if (
    error['code'] === 'execution_failed' &&
    hasExactKeys(error, ['code', 'message']) &&
    Object.hasOwn(error, 'message')
  ) {
    const message = normalizeExecutionFailureMessage(error['message']);
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
      const envelope = parseTerminalEnvelope(status.output, executionPlan);
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
