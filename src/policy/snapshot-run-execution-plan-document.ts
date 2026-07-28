import type {
  RunExecutionPlanDocument,
  RunExecutionPlanExecutorBinding,
  RunExecutionPlanTerminalBinding,
} from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { forEachArrayValue } from './for-each-array-value.js';
import { snapshotExecutionPlanPin } from './snapshot-execution-plan-pin.js';
import { snapshotPortableJsonValue } from './snapshot-portable-json-value.js';
import { snapshotRunExecutionPlanExecutorBinding } from './snapshot-run-execution-plan-executor-binding.js';
import { snapshotRunExecutionPlanTerminalBinding } from './snapshot-run-execution-plan-terminal-binding.js';

export const snapshotRunExecutionPlanDocument = (value: unknown): RunExecutionPlanDocument => {
  const record = contractValidation.snapshotRecord(value, [
    'compiledPipeline',
    'executorBindings',
    'pin',
    'terminalBindings',
  ]);
  const sourceBindings = contractValidation.array(record['executorBindings'], 4_096);
  const bindings: RunExecutionPlanExecutorBinding[] = [];
  const nodeKeys = new Set<string>();
  const sourceTerminalBindings = contractValidation.array(record['terminalBindings'], 4_096);
  const terminalBindings: RunExecutionPlanTerminalBinding[] = [];
  const terminalKeys = new Set<string>();

  forEachArrayValue(sourceBindings, (sourceBinding) => {
    const binding = snapshotRunExecutionPlanExecutorBinding(sourceBinding);
    if (nodeKeys.has(binding.nodeKey)) {
      throw new TypeError('Execution plan executor bindings must use unique node keys.');
    }
    nodeKeys.add(binding.nodeKey);
    bindings.push(binding);
  });
  forEachArrayValue(sourceTerminalBindings, (sourceBinding) => {
    const binding = snapshotRunExecutionPlanTerminalBinding(sourceBinding);
    const key = JSON.stringify([binding.nodeKey, binding.outcome]);
    if (terminalKeys.has(key)) {
      throw new TypeError('Execution plan terminal bindings must be unique.');
    }
    terminalKeys.add(key);
    terminalBindings.push(binding);
  });

  const document: RunExecutionPlanDocument = Object.freeze({
    compiledPipeline: contractValidation.requiredValue(record, 'compiledPipeline'),
    executorBindings: Object.freeze(bindings),
    pin: snapshotExecutionPlanPin(record['pin']),
    terminalBindings: Object.freeze(terminalBindings),
  });
  snapshotPortableJsonValue(document);
  return document;
};
