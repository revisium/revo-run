import type { JsonValue } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotExecutorOutputs } from './snapshot-executor-outputs.js';
import { snapshotRunOutputPayload } from './snapshot-run-output-payload.js';
import { snapshotRunProgressionAppliedReceipt } from './snapshot-run-progression-applied-receipt.js';
import { snapshotRunProgressionOccurrenceKey } from './snapshot-run-progression-occurrence-key.js';
import { snapshotRunProgressionValueFacts } from './snapshot-run-progression-value-facts.js';

type CommandOperation =
  | 'initialize'
  | 'task_outcome'
  | 'consensus_verdict'
  | 'human_gate_resolution';

type CommandIdentity = {
  readonly operation: CommandOperation;
  readonly nodeKey: string | null;
  readonly commandKey: string;
};

type ValueFact = { readonly key: string; readonly value: null | boolean | number | string };

type SemanticRequest =
  | {
      readonly kind: 'initialize';
      readonly occurrenceKey: string;
      readonly values: readonly ValueFact[];
    }
  | {
      readonly kind: 'task_outcome';
      readonly nodeKey: string;
      readonly outcome:
        | { readonly kind: 'succeeded'; readonly values: readonly ValueFact[] }
        | { readonly kind: 'failed'; readonly faultCode: string; readonly faultMessage: string }
        | { readonly kind: 'cancelled' | 'skipped' };
    }
  | {
      readonly kind: 'consensus_verdict';
      readonly nodeKey: string;
      readonly candidateKey: string;
      readonly verdict: 'approve' | 'reject' | 'abstain';
    }
  | {
      readonly kind: 'human_gate_resolution';
      readonly nodeKey: string;
      readonly activationId: string;
      readonly resolution: string;
      readonly values: readonly ValueFact[];
    };

const operation = (value: JsonValue | undefined): CommandOperation => {
  if (
    value === 'initialize' ||
    value === 'task_outcome' ||
    value === 'consensus_verdict' ||
    value === 'human_gate_resolution'
  ) {
    return value;
  }
  throw new TypeError('Run progression command identity is invalid.');
};

const identity = (value: JsonValue): CommandIdentity => {
  const record = contractValidation.record(value, ['commandKey', 'nodeKey', 'operation']);
  const nodeKey =
    record['nodeKey'] === null ? null : contractValidation.boundedString(record['nodeKey'], 256);
  const parsed = Object.freeze({
    commandKey: contractValidation.boundedString(record['commandKey'], 256),
    nodeKey,
    operation: operation(record['operation']),
  });
  if ((parsed.operation === 'initialize') !== (nodeKey === null)) {
    throw new TypeError('Run progression command identity target is invalid.');
  }
  return parsed;
};

const taskOutcome = (
  value: JsonValue,
): Extract<SemanticRequest, { readonly kind: 'task_outcome' }>['outcome'] => {
  const base = contractValidation.record(value, ['kind'], ['faultCode', 'faultMessage', 'values']);
  if (base['kind'] === 'succeeded') {
    const record = contractValidation.record(base, ['kind', 'values']);
    return Object.freeze({
      kind: 'succeeded',
      values: snapshotRunProgressionValueFacts(record['values']),
    });
  }
  if (base['kind'] === 'failed') {
    const record = contractValidation.record(base, ['faultCode', 'faultMessage', 'kind']);
    return Object.freeze({
      faultCode: contractValidation.boundedString(record['faultCode'], 256),
      faultMessage: contractValidation.boundedString(record['faultMessage'], 512),
      kind: 'failed',
    });
  }
  if (base['kind'] === 'cancelled' || base['kind'] === 'skipped') {
    contractValidation.record(base, ['kind']);
    return Object.freeze({ kind: base['kind'] });
  }
  throw new TypeError('Run progression task outcome is invalid.');
};

const semanticRequest = (value: JsonValue): SemanticRequest => {
  const base = contractValidation.record(
    value,
    ['kind'],
    [
      'activationId',
      'candidateKey',
      'nodeKey',
      'occurrenceKey',
      'outcome',
      'resolution',
      'values',
      'verdict',
    ],
  );
  if (base['kind'] === 'initialize') {
    const record = contractValidation.record(base, ['kind', 'occurrenceKey', 'values']);
    return Object.freeze({
      kind: 'initialize',
      occurrenceKey: snapshotRunProgressionOccurrenceKey(record['occurrenceKey']),
      values: snapshotRunProgressionValueFacts(record['values']),
    });
  }
  if (base['kind'] === 'task_outcome') {
    const record = contractValidation.record(base, ['kind', 'nodeKey', 'outcome']);
    return Object.freeze({
      kind: 'task_outcome',
      nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
      outcome: taskOutcome(contractValidation.requiredValue(record, 'outcome')),
    });
  }
  if (base['kind'] === 'consensus_verdict') {
    const record = contractValidation.record(base, ['candidateKey', 'kind', 'nodeKey', 'verdict']);
    if (
      record['verdict'] !== 'approve' &&
      record['verdict'] !== 'reject' &&
      record['verdict'] !== 'abstain'
    ) {
      throw new TypeError('Run progression verdict is invalid.');
    }
    return Object.freeze({
      candidateKey: contractValidation.boundedString(record['candidateKey'], 256),
      kind: 'consensus_verdict',
      nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
      verdict: record['verdict'],
    });
  }
  if (base['kind'] === 'human_gate_resolution') {
    const record = contractValidation.record(base, [
      'activationId',
      'kind',
      'nodeKey',
      'resolution',
      'values',
    ]);
    return Object.freeze({
      activationId: contractValidation.boundedString(record['activationId'], 256),
      kind: 'human_gate_resolution',
      nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
      resolution: contractValidation.boundedString(record['resolution'], 256),
      values: snapshotRunProgressionValueFacts(record['values']),
    });
  }
  throw new TypeError('Run progression semantic request is invalid.');
};

export const snapshotRunProgressionCommandReceipt = (value: unknown) => {
  const record = contractValidation.snapshotRecord(value, [
    'hostAttachment',
    'identity',
    'result',
    'semanticRequest',
  ]);
  const attachment = contractValidation.record(
    contractValidation.requiredValue(record, 'hostAttachment'),
    ['kind'],
    ['answerOutput', 'outputs'],
  );
  const hostAttachment =
    attachment['kind'] === 'none'
      ? (contractValidation.record(attachment, ['kind']), Object.freeze({ kind: 'none' }))
      : attachment['kind'] === 'task_outputs'
        ? (() => {
            const exact = contractValidation.record(attachment, ['kind', 'outputs']);
            return Object.freeze({
              kind: 'task_outputs',
              outputs: snapshotExecutorOutputs(exact['outputs']),
            });
          })()
        : attachment['kind'] === 'gate_answer_output'
          ? (() => {
              const exact = contractValidation.record(attachment, ['answerOutput', 'kind']);
              return Object.freeze({
                answerOutput: snapshotRunOutputPayload(exact['answerOutput']),
                kind: 'gate_answer_output',
              });
            })()
          : (() => {
              throw new TypeError('Run progression host attachment is invalid.');
            })();
  const parsedIdentity = identity(contractValidation.requiredValue(record, 'identity'));
  const parsedRequest = semanticRequest(
    contractValidation.requiredValue(record, 'semanticRequest'),
  );
  const result = snapshotRunProgressionAppliedReceipt(record['result']);
  const requestNodeKey = 'nodeKey' in parsedRequest ? parsedRequest.nodeKey : null;
  const validAttachment =
    (parsedRequest.kind === 'task_outcome' &&
      parsedRequest.outcome.kind === 'succeeded' &&
      hostAttachment.kind === 'task_outputs') ||
    (parsedRequest.kind === 'human_gate_resolution' &&
      hostAttachment.kind === 'gate_answer_output') ||
    ((parsedRequest.kind === 'initialize' ||
      parsedRequest.kind === 'consensus_verdict' ||
      (parsedRequest.kind === 'task_outcome' && parsedRequest.outcome.kind !== 'succeeded')) &&
      hostAttachment.kind === 'none');
  if (
    parsedIdentity.operation !== parsedRequest.kind ||
    parsedIdentity.nodeKey !== requestNodeKey ||
    result.operation !== parsedIdentity.operation ||
    (parsedRequest.kind === 'initialize' && result.occurrenceKey !== parsedRequest.occurrenceKey) ||
    !validAttachment
  ) {
    throw new TypeError('Run progression command receipt binding is invalid.');
  }
  return Object.freeze({
    hostAttachment,
    identity: parsedIdentity,
    result,
    semanticRequest: parsedRequest,
  });
};
