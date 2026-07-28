import { digestCanonicalJson } from './canonical-json/digest-canonical-json.js';
import { contractValidation } from './contract-validation.js';
import { snapshotRunProgressionOccurrenceKey } from './snapshot-run-progression-occurrence-key.js';

export const deriveRunProgressionIdentity = (
  value: Readonly<{
    operation: 'initialize' | 'task_outcome' | 'consensus_verdict' | 'human_gate_resolution';
    occurrenceKey: string;
    nodeKey: string | null;
    coordinate: string;
  }>,
) => {
  const occurrenceKey = snapshotRunProgressionOccurrenceKey(value.occurrenceKey);
  const coordinate = contractValidation.boundedString(value.coordinate, 256);
  const nodeKey =
    value.nodeKey === null ? null : contractValidation.boundedString(value.nodeKey, 256);
  if ((value.operation === 'initialize') !== (nodeKey === null)) {
    throw new TypeError('Run progression identity target is invalid.');
  }
  return Object.freeze({
    commandKey: digestCanonicalJson([
      'revo-run',
      'progression-command',
      'v1',
      occurrenceKey,
      value.operation,
      nodeKey,
      coordinate,
    ]),
    nodeKey,
    operation: value.operation,
  });
};
