import type { RunOutputPayload } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotRunArtifactReference } from './snapshot-run-artifact-reference.js';

export const snapshotRunOutputPayload = (value: unknown): RunOutputPayload => {
  const base = contractValidation.snapshotRecord(value, ['kind'], ['artifact', 'value']);
  const kind = base['kind'];
  if (kind === 'json') {
    const record = contractValidation.record(base, ['kind', 'value']);
    return Object.freeze({
      kind,
      value: contractValidation.requiredValue(record, 'value'),
    });
  }
  if (kind === 'artifact') {
    const record = contractValidation.record(base, ['artifact', 'kind']);
    return Object.freeze({
      artifact: snapshotRunArtifactReference(record['artifact']),
      kind,
    });
  }
  throw new TypeError('Run output payload kind is invalid.');
};
