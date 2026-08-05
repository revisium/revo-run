import { decodeCompiledPipeline, type JsonValue } from '@revisium/revo-pipeline';

import { snapshotJsonValue } from '../json/snapshot-json.js';
import type { ExecutionPlan, StartRunInput } from '../types.js';

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScriptIdentity = (value: JsonValue): boolean =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  value['id'].startsWith('script:') &&
  typeof value['version'] === 'number' &&
  Number.isInteger(value['version']);

const isExecutorRequirement = (value: JsonValue): boolean =>
  isRecord(value) &&
  value['kind'] === 'script' &&
  typeof value['nodeKey'] === 'string' &&
  value['script'] !== undefined &&
  isScriptIdentity(value['script']) &&
  'input' in value;

const isTerminalBinding = (value: JsonValue): boolean =>
  isRecord(value) && typeof value['nodeKey'] === 'string' && typeof value['outcome'] === 'string';

const isExecutionPlan = (value: JsonValue): value is ExecutionPlan =>
  isRecord(value) &&
  value['pipeline'] !== undefined &&
  decodeCompiledPipeline(value['pipeline']).ok &&
  Array.isArray(value['executorRequirements']) &&
  value['executorRequirements'].every(isExecutorRequirement) &&
  Array.isArray(value['terminalBindings']) &&
  value['terminalBindings'].every(isTerminalBinding);

export const snapshotExecutionPlan = (value: unknown): ExecutionPlan => {
  const snapshot = snapshotJsonValue(value, 'Execution plan');
  if (!isExecutionPlan(snapshot)) {
    throw new TypeError('Execution plan is invalid.');
  }
  return snapshot;
};

export const snapshotRunInput = (value: unknown): JsonValue =>
  snapshotJsonValue(value, 'Run input');

export const snapshotStartRunInput = (value: StartRunInput): StartRunInput => ({
  executionPlan: snapshotExecutionPlan(value.executionPlan),
  input: snapshotRunInput(value.input),
  runId: value.runId,
});
