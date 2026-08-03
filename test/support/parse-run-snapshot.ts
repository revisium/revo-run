import type { RunSnapshot } from '../../src/index.js';

const isRunSnapshot = (value: unknown): value is RunSnapshot =>
  typeof value !== 'object' || value === null
    ? false
    : 'id' in value &&
      typeof value.id === 'string' &&
      'status' in value &&
      ['pending', 'running', 'succeeded', 'failed'].includes(String(value.status)) &&
      'planPin' in value &&
      'input' in value &&
      'result' in value &&
      'error' in value;

export const parseRunSnapshot = (source: string): RunSnapshot => {
  const value: unknown = JSON.parse(source);
  if (!isRunSnapshot(value)) {
    throw new Error('Persisted run snapshot is invalid.');
  }
  return value;
};
