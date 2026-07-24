import type { RunExecutionPlanDocument, RunExecutionPlanExecutorBinding } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotExecutionPlanPin } from './snapshot-execution-plan-pin.js';
import { snapshotPortableJsonValue } from './snapshot-portable-json-value.js';
import { snapshotRunExecutionPlanExecutorBinding } from './snapshot-run-execution-plan-executor-binding.js';

export const snapshotRunExecutionPlanDocument = (value: unknown): RunExecutionPlanDocument => {
  const record = contractValidation.snapshotRecord(value, [
    'compiledPipeline',
    'executorBindings',
    'pin',
  ]);
  const sourceBindings = contractValidation.array(record['executorBindings'], 4_096);
  const bindings: RunExecutionPlanExecutorBinding[] = [];
  const nodeKeys = new Set<string>();

  for (let index = 0; index < sourceBindings.length; index += 1) {
    const binding = snapshotRunExecutionPlanExecutorBinding(sourceBindings[index]);
    if (nodeKeys.has(binding.nodeKey)) {
      throw new TypeError('Execution plan executor bindings must use unique node keys.');
    }
    nodeKeys.add(binding.nodeKey);
    bindings.push(binding);
  }

  const document: RunExecutionPlanDocument = Object.freeze({
    compiledPipeline: contractValidation.requiredValue(record, 'compiledPipeline'),
    executorBindings: Object.freeze(bindings),
    pin: snapshotExecutionPlanPin(record['pin']),
  });
  snapshotPortableJsonValue(document);
  return document;
};
