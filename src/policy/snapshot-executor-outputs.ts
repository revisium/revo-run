import type { ExecutorOutput } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { forEachArrayValue } from './for-each-array-value.js';
import { snapshotExecutorOutput } from './snapshot-executor-output.js';
import { snapshotPortableJsonValue } from './snapshot-portable-json-value.js';

export const snapshotExecutorOutputs = (value: unknown): readonly ExecutorOutput[] => {
  const source = snapshotPortableJsonValue(value);
  const values = contractValidation.array(source, 4_096);
  const outputs: ExecutorOutput[] = [];
  const names = new Set<string>();
  forEachArrayValue(values, (item) => {
    const output = snapshotExecutorOutput(item);
    if (names.has(output.name)) {
      throw new TypeError('Executor outputs must use unique names.');
    }
    names.add(output.name);
    outputs.push(output);
  });
  const snapshot = Object.freeze(outputs);
  snapshotPortableJsonValue(snapshot);
  return snapshot;
};
