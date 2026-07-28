import { contractValidation } from './contract-validation.js';
import { snapshotRunFaultMessage } from './snapshot-run-fault-message.js';
import { snapshotRunProgressionOccurrenceKey } from './snapshot-run-progression-occurrence-key.js';

const operation = (
  value: unknown,
):
  | 'initialize'
  | 'task_outcome'
  | 'consensus_verdict'
  | 'human_gate_resolution'
  | 'retired_attempt_observation' => {
  if (
    value === 'initialize' ||
    value === 'task_outcome' ||
    value === 'consensus_verdict' ||
    value === 'human_gate_resolution' ||
    value === 'retired_attempt_observation'
  ) {
    return value;
  }
  throw new TypeError('Run progression applied receipt operation is invalid.');
};

export const snapshotRunProgressionAppliedReceipt = (value: unknown) => {
  const record = contractValidation.snapshotRecord(
    value,
    ['application', 'occurrenceKey', 'operation', 'outcome', 'schemaVersion'],
    ['attemptObservation'],
  );
  if (
    record['application'] !== 'applied' ||
    record['schemaVersion'] !== 1 ||
    typeof record['operation'] !== 'string'
  ) {
    throw new TypeError('Run progression applied receipt is invalid.');
  }
  const parsedOperation = operation(record['operation']);
  const rawObservation = record['attemptObservation'];
  if ((parsedOperation === 'retired_attempt_observation') !== (rawObservation !== undefined)) {
    throw new TypeError('Run progression cleanup observation is invalid.');
  }
  const attemptObservation =
    parsedOperation === 'retired_attempt_observation'
      ? (() => {
          const observation = contractValidation.record(
            contractValidation.requiredValue(record, 'attemptObservation'),
            ['attemptId', 'fault', 'nodeKey', 'status', 'terminalAt'],
          );
          if (
            observation['status'] !== 'succeeded' &&
            observation['status'] !== 'failed' &&
            observation['status'] !== 'cancelled'
          ) {
            throw new TypeError('Run progression cleanup observation status is invalid.');
          }
          const fault =
            observation['fault'] === null
              ? null
              : (() => {
                  const faultRecord = contractValidation.record(
                    contractValidation.requiredValue(observation, 'fault'),
                    ['code', 'message'],
                  );
                  const code = contractValidation.boundedString(faultRecord['code'], 64);
                  if (
                    code !== 'INVALID_INPUT' &&
                    code !== 'INVALID_STATE' &&
                    code !== 'STALE_ACTIVATION' &&
                    code !== 'REVISION_CONFLICT' &&
                    code !== 'STALE_FENCE' &&
                    code !== 'PLAN_UNAVAILABLE' &&
                    code !== 'PLAN_MISMATCH' &&
                    code !== 'EXECUTOR_UNAVAILABLE' &&
                    code !== 'EXECUTOR_MISMATCH'
                  ) {
                    throw new TypeError('Run progression cleanup observation fault is invalid.');
                  }
                  return Object.freeze({
                    code,
                    message: snapshotRunFaultMessage(faultRecord['message']),
                  });
                })();
          if ((observation['status'] === 'failed') !== (fault !== null)) {
            throw new TypeError('Run progression cleanup observation fault is invalid.');
          }
          return Object.freeze({
            attemptId: contractValidation.boundedString(observation['attemptId'], 256),
            fault,
            nodeKey: contractValidation.boundedString(observation['nodeKey'], 256),
            status: observation['status'],
            terminalAt: contractValidation.boundedInteger(
              observation['terminalAt'],
              0,
              Number.MAX_SAFE_INTEGER,
            ),
          });
        })()
      : null;
  const occurrenceKey = snapshotRunProgressionOccurrenceKey(record['occurrenceKey']);
  const outcome = contractValidation.record(
    contractValidation.requiredValue(record, 'outcome'),
    ['kind'],
    ['terminal'],
  );
  if (outcome['kind'] === 'waiting') {
    contractValidation.record(outcome, ['kind']);
    return Object.freeze({
      ...(attemptObservation === null ? {} : { attemptObservation }),
      application: 'applied',
      occurrenceKey,
      operation: parsedOperation,
      outcome: Object.freeze({ kind: 'waiting' }),
      schemaVersion: 1,
    });
  }
  if (outcome['kind'] !== 'terminal') {
    throw new TypeError('Run progression applied receipt outcome is invalid.');
  }
  const terminal = contractValidation.record(
    contractValidation.requiredValue(outcome, 'terminal'),
    ['fault', 'nodeKey', 'outcome', 'status'],
  );
  const nodeKey = contractValidation.boundedString(terminal['nodeKey'], 256);
  const terminalOutcome = contractValidation.boundedString(terminal['outcome'], 256);
  if (terminal['status'] === 'succeeded' || terminal['status'] === 'cancelled') {
    if (terminal['fault'] !== null) {
      throw new TypeError('Run progression applied receipt terminal fault is invalid.');
    }
    return Object.freeze({
      ...(attemptObservation === null ? {} : { attemptObservation }),
      application: 'applied',
      occurrenceKey,
      operation: parsedOperation,
      outcome: Object.freeze({
        kind: 'terminal',
        terminal: Object.freeze({
          fault: null,
          nodeKey,
          outcome: terminalOutcome,
          status: terminal['status'],
        }),
      }),
      schemaVersion: 1,
    });
  }
  if (terminal['status'] !== 'failed') {
    throw new TypeError('Run progression applied receipt terminal status is invalid.');
  }
  const fault = contractValidation.record(terminal['fault'] ?? null, ['code', 'message']);
  if (fault['code'] !== 'PIPELINE_TERMINAL') {
    throw new TypeError('Run progression applied receipt terminal fault is invalid.');
  }
  return Object.freeze({
    ...(attemptObservation === null ? {} : { attemptObservation }),
    application: 'applied',
    occurrenceKey,
    operation: parsedOperation,
    outcome: Object.freeze({
      kind: 'terminal',
      terminal: Object.freeze({
        fault: Object.freeze({
          code: 'PIPELINE_TERMINAL',
          message: snapshotRunFaultMessage(fault['message']),
        }),
        nodeKey,
        outcome: terminalOutcome,
        status: 'failed',
      }),
    }),
    schemaVersion: 1,
  });
};
