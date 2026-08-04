import { decodeCompiledPipeline, type JsonValue } from '@revisium/revo-pipeline';

import type { ExecutionPlan, StartRunInput } from '../types.js';

const invalidInput = (label: string): never => {
  throw new TypeError(`${label} must be JSON-safe.`);
};

const cloneJson = (value: unknown, label: string, ancestors = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidInput(label);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      return invalidInput(label);
    }
    if (ancestors.has(value)) {
      return invalidInput(label);
    }
    ancestors.add(value);
    const clone = value.map((member) => cloneJson(member, label, ancestors));
    ancestors.delete(value);
    return clone;
  }
  if (typeof value !== 'object' || value === null) {
    return invalidInput(label);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput(label);
  }
  if (ancestors.has(value)) {
    return invalidInput(label);
  }
  ancestors.add(value);
  const clone: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    clone[key] = cloneJson(member, label, ancestors);
  }
  ancestors.delete(value);
  return clone;
};

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
  const snapshot = cloneJson(value, 'Execution plan');
  if (!isExecutionPlan(snapshot)) {
    throw new TypeError('Execution plan is invalid.');
  }
  return snapshot;
};

export const snapshotRunInput = (value: unknown): JsonValue => cloneJson(value, 'Run input');

export const snapshotStartRunInput = (value: StartRunInput): StartRunInput => ({
  executionPlan: snapshotExecutionPlan(value.executionPlan),
  input: snapshotRunInput(value.input),
  runId: value.runId,
});
