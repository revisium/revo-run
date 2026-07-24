import type { RunArtifactReference } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

export const snapshotRunArtifactReference = (value: unknown): RunArtifactReference => {
  const record = contractValidation.snapshotRecord(value, [
    'artifactId',
    'bytes',
    'mediaType',
    'sha256',
  ]);
  return Object.freeze({
    artifactId: contractValidation.boundedString(record['artifactId'], 256),
    bytes: contractValidation.boundedInteger(record['bytes'], 0, Number.MAX_SAFE_INTEGER),
    mediaType: contractValidation.mediaType(record['mediaType']),
    sha256: contractValidation.sha256Hex(record['sha256']),
  });
};
