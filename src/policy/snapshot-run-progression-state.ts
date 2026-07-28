import type { JsonValue } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { forEachArrayValue } from './for-each-array-value.js';
import { snapshotRunProgressionCommandReceipt } from './snapshot-run-progression-command-receipt.js';
import { snapshotRunProgressionOccurrenceKey } from './snapshot-run-progression-occurrence-key.js';

type Terminal = { readonly nodeKey: string; readonly outcome: string };
type ValueRecord = {
  readonly key: string;
  readonly value: null | boolean | number | string;
  readonly source:
    | { readonly kind: 'init' }
    | { readonly kind: 'task_outcome' | 'human_gate_resolution'; readonly nodeKey: string };
};
type CandidateVerdict = {
  readonly nodeKey: string;
  readonly candidateKey: string;
  readonly verdict: 'approve' | 'reject' | 'abstain';
};
type GateResolution = { readonly nodeKey: string; readonly resolution: string };
type CommandReceipt = ReturnType<typeof snapshotRunProgressionCommandReceipt>;

const terminal = (value: JsonValue): Terminal => {
  const record = contractValidation.record(value, ['nodeKey', 'outcome']);
  return Object.freeze({
    nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
    outcome: contractValidation.boundedString(record['outcome'], 256),
  });
};

const valueRecords = (value: JsonValue | undefined): readonly ValueRecord[] => {
  const source = contractValidation.array(value, 4_096);
  const records: ValueRecord[] = [];
  const keys = new Set<string>();
  forEachArrayValue(source, (candidate) => {
    const record = contractValidation.record(candidate, ['key', 'source', 'value']);
    const key = contractValidation.boundedString(record['key'], 256);
    const factValue = record['value'];
    const sourceRecord = contractValidation.record(
      contractValidation.requiredValue(record, 'source'),
      ['kind'],
      ['nodeKey'],
    );
    const factSource =
      sourceRecord['kind'] === 'init'
        ? (contractValidation.record(sourceRecord, ['kind']), Object.freeze({ kind: 'init' }))
        : sourceRecord['kind'] === 'task_outcome' ||
            sourceRecord['kind'] === 'human_gate_resolution'
          ? Object.freeze({
              kind: sourceRecord['kind'],
              nodeKey: contractValidation.boundedString(sourceRecord['nodeKey'], 256),
            })
          : (() => {
              throw new TypeError('Run progression value source is invalid.');
            })();
    if (
      !(
        factValue === null ||
        typeof factValue === 'boolean' ||
        typeof factValue === 'string' ||
        (typeof factValue === 'number' && Number.isFinite(factValue))
      ) ||
      keys.has(key)
    ) {
      throw new TypeError('Run progression values are invalid.');
    }
    keys.add(key);
    records.push(Object.freeze({ key, source: factSource, value: factValue }));
  });
  return Object.freeze(records);
};

const verdicts = (value: JsonValue | undefined): readonly CandidateVerdict[] => {
  const source = contractValidation.array(value, 4_096);
  const result: CandidateVerdict[] = [];
  const keys = new Set<string>();
  forEachArrayValue(source, (candidate) => {
    const record = contractValidation.record(candidate, ['candidateKey', 'nodeKey', 'verdict']);
    if (
      record['verdict'] !== 'approve' &&
      record['verdict'] !== 'reject' &&
      record['verdict'] !== 'abstain'
    ) {
      throw new TypeError('Run progression candidate verdict is invalid.');
    }
    const item = Object.freeze({
      candidateKey: contractValidation.boundedString(record['candidateKey'], 256),
      nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
      verdict: record['verdict'],
    });
    const key = JSON.stringify([item.nodeKey, item.candidateKey]);
    if (keys.has(key)) throw new TypeError('Run progression candidate verdict is duplicated.');
    keys.add(key);
    result.push(item);
  });
  return Object.freeze(result);
};

const gateResolutions = (value: JsonValue | undefined): readonly GateResolution[] => {
  const source = contractValidation.array(value, 4_096);
  const result: GateResolution[] = [];
  const keys = new Set<string>();
  forEachArrayValue(source, (candidate) => {
    const record = contractValidation.record(candidate, ['nodeKey', 'resolution']);
    const item = Object.freeze({
      nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
      resolution: contractValidation.boundedString(record['resolution'], 256),
    });
    if (keys.has(item.nodeKey))
      throw new TypeError('Run progression gate resolution is duplicated.');
    keys.add(item.nodeKey);
    result.push(item);
  });
  return Object.freeze(result);
};

const receipts = (value: JsonValue | undefined): readonly CommandReceipt[] => {
  const source = contractValidation.array(value, 4_096);
  const result: CommandReceipt[] = [];
  const keys = new Set<string>();
  forEachArrayValue(source, (candidate) => {
    const receipt = snapshotRunProgressionCommandReceipt(candidate);
    const key = JSON.stringify([
      receipt.identity.operation,
      receipt.identity.nodeKey,
      receipt.identity.commandKey,
    ]);
    if (keys.has(key)) throw new TypeError('Run progression command receipt is duplicated.');
    keys.add(key);
    result.push(receipt);
  });
  return Object.freeze(result);
};

export const snapshotRunProgressionState = (value: unknown) => {
  const record = contractValidation.snapshotRecord(value, [
    'candidateVerdicts',
    'commandReceipts',
    'gateResolutions',
    'nodes',
    'occurrenceKey',
    'phase',
    'schemaVersion',
    'terminal',
    'values',
  ]);
  if (record['schemaVersion'] !== 1) {
    throw new TypeError('Run progression state version is invalid.');
  }
  const occurrenceKey = snapshotRunProgressionOccurrenceKey(record['occurrenceKey']);
  const sourceNodes = contractValidation.array(record['nodes'], 4_096);
  if (record['phase'] === 'uninitialized') {
    if (
      sourceNodes.length !== 0 ||
      contractValidation.array(record['values'], 0).length !== 0 ||
      contractValidation.array(record['candidateVerdicts'], 0).length !== 0 ||
      contractValidation.array(record['gateResolutions'], 0).length !== 0 ||
      contractValidation.array(record['commandReceipts'], 0).length !== 0 ||
      record['terminal'] !== null
    ) {
      throw new TypeError('Uninitialized Run progression state is invalid.');
    }
    const empty: readonly [] = Object.freeze([]);
    return Object.freeze({
      candidateVerdicts: empty,
      commandReceipts: empty,
      gateResolutions: empty,
      nodes: empty,
      occurrenceKey,
      phase: 'uninitialized',
      schemaVersion: 1,
      terminal: null,
      values: empty,
    });
  }
  const nodes: (
    | { readonly nodeKey: string; readonly state: 'enabled' }
    | { readonly nodeKey: string; readonly state: 'terminal'; readonly outcome: string }
    | {
        readonly nodeKey: string;
        readonly state: 'retired';
        readonly terminal: Terminal;
      }
  )[] = [];
  const nodeKeys = new Set<string>();
  forEachArrayValue(sourceNodes, (candidate) => {
    const node = contractValidation.record(
      candidate,
      ['nodeKey', 'state'],
      ['outcome', 'terminal'],
    );
    const nodeKey = contractValidation.boundedString(node['nodeKey'], 256);
    if (nodeKeys.has(nodeKey)) throw new TypeError('Run progression node is duplicated.');
    nodeKeys.add(nodeKey);
    if (node['state'] === 'enabled') {
      contractValidation.record(node, ['nodeKey', 'state']);
      nodes.push(Object.freeze({ nodeKey, state: 'enabled' }));
    } else if (node['state'] === 'terminal') {
      contractValidation.record(node, ['nodeKey', 'outcome', 'state']);
      nodes.push(
        Object.freeze({
          nodeKey,
          outcome: contractValidation.boundedString(node['outcome'], 256),
          state: 'terminal',
        }),
      );
    } else if (node['state'] === 'retired') {
      contractValidation.record(node, ['nodeKey', 'state', 'terminal']);
      nodes.push(
        Object.freeze({
          nodeKey,
          state: 'retired',
          terminal: terminal(contractValidation.requiredValue(node, 'terminal')),
        }),
      );
    } else {
      throw new TypeError('Run progression node state is invalid.');
    }
  });
  const common = {
    candidateVerdicts: verdicts(record['candidateVerdicts']),
    commandReceipts: receipts(record['commandReceipts']),
    gateResolutions: gateResolutions(record['gateResolutions']),
    nodes: Object.freeze(nodes),
    occurrenceKey,
    schemaVersion: 1,
    values: valueRecords(record['values']),
  };
  if (record['phase'] === 'active' && record['terminal'] === null) {
    if (nodes.some((node) => node.state === 'retired')) {
      throw new TypeError('Active Run progression state is invalid.');
    }
    const activeNodes: (
      | { readonly nodeKey: string; readonly state: 'enabled' }
      | { readonly nodeKey: string; readonly state: 'terminal'; readonly outcome: string }
    )[] = [];
    for (const node of nodes) {
      if (node.state === 'enabled' || node.state === 'terminal') activeNodes.push(node);
    }
    return Object.freeze({
      ...common,
      nodes: Object.freeze(activeNodes),
      phase: 'active',
      schemaVersion: 1,
      terminal: null,
    });
  }
  if (record['phase'] === 'terminal' && record['terminal'] !== null) {
    if (nodes.some((node) => node.state === 'enabled')) {
      throw new TypeError('Terminal Run progression state is invalid.');
    }
    const terminalNodes: (
      | { readonly nodeKey: string; readonly state: 'terminal'; readonly outcome: string }
      | {
          readonly nodeKey: string;
          readonly state: 'retired';
          readonly terminal: Terminal;
        }
    )[] = [];
    for (const node of nodes) {
      if (node.state === 'terminal' || node.state === 'retired') terminalNodes.push(node);
    }
    return Object.freeze({
      ...common,
      nodes: Object.freeze(terminalNodes),
      phase: 'terminal',
      schemaVersion: 1,
      terminal: terminal(contractValidation.requiredValue(record, 'terminal')),
    });
  }
  throw new TypeError('Run progression phase is invalid.');
};
