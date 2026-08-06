import type { JsonValue } from '@revisium/revo-pipeline';

import type { RunWorkflowInput } from '../execution/run-workflow-input.js';
import type { ExecutionPlan } from '../run/execution-plan.js';
import type { RunResult } from '../run/run.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isExecutionPlan = (value: unknown): value is ExecutionPlan =>
  isRecord(value) &&
  isRecord(value['pipeline']) &&
  Array.isArray(value['executorRequirements']) &&
  Array.isArray(value['terminalBindings']);

const isStoredJsonValue = (value: unknown): value is JsonValue =>
  value === null ||
  ['boolean', 'number', 'string'].includes(typeof value) ||
  Array.isArray(value) ||
  isRecord(value);

export const parseRunWorkflowInput = (value: unknown[] | undefined): RunWorkflowInput => {
  if (value?.length !== 1 || !isRecord(value[0])) {
    throw new Error('Run workflow input is invalid.');
  }

  const executionPlan = value[0]['executionPlan'];
  const input = value[0]['input'];
  if (!isExecutionPlan(executionPlan) || !isStoredJsonValue(input)) {
    throw new Error('Run workflow input is invalid.');
  }

  return { executionPlan, input };
};

export const parseRunWorkflowResult = (value: unknown): RunResult => {
  if (!isRecord(value) || typeof value['outcome'] !== 'string') {
    throw new Error('Run workflow output is invalid.');
  }

  return { outcome: value['outcome'] };
};
