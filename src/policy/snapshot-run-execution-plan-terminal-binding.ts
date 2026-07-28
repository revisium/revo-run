import type { RunExecutionPlanTerminalBinding } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotRunFaultMessage } from './snapshot-run-fault-message.js';

export const snapshotRunExecutionPlanTerminalBinding = (
  value: unknown,
): RunExecutionPlanTerminalBinding => {
  const base = contractValidation.snapshotRecord(
    value,
    ['nodeKey', 'outcome', 'status'],
    ['fault'],
  );
  const nodeKey = contractValidation.boundedString(base['nodeKey'], 256);
  const outcome = contractValidation.boundedString(base['outcome'], 256);
  if (base['status'] === 'succeeded' || base['status'] === 'cancelled') {
    contractValidation.record(base, ['nodeKey', 'outcome', 'status']);
    return Object.freeze({ nodeKey, outcome, status: base['status'] });
  }
  if (base['status'] !== 'failed') {
    throw new TypeError('Execution plan terminal binding status is invalid.');
  }
  const fault = contractValidation.record(contractValidation.requiredValue(base, 'fault'), [
    'code',
    'message',
  ]);
  if (fault['code'] !== 'PIPELINE_TERMINAL') {
    throw new TypeError('Execution plan terminal binding fault is invalid.');
  }
  return Object.freeze({
    fault: Object.freeze({
      code: 'PIPELINE_TERMINAL',
      message: snapshotRunFaultMessage(fault['message']),
    }),
    nodeKey,
    outcome,
    status: 'failed',
  });
};
