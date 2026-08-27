import { createHash } from 'node:crypto';

const identifier = (prefix: string, payload: readonly (string | number)[]): string =>
  `${prefix}${createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('base64url')}`;

export const operationId = (runId: string, commandKey: string): string =>
  identifier('op_', ['revo-run-operation/v1', runId, commandKey]);

export const attemptId = (operation: string, ordinal: number): string =>
  identifier('att_', ['revo-run-attempt/v1', operation, ordinal]);

export const waitId = (runId: string, commandKey: string): string =>
  identifier('wait_', ['revo-run-wait/v1', runId, commandKey]);

export const gateId = (runId: string, commandKey: string): string =>
  identifier('gate_', ['revo-run-gate/v1', runId, commandKey]);

export const eventReceiptId = (
  runId: string,
  operation: string,
  attempt: string,
  emissionOrdinal: number,
): string =>
  identifier('evr_', [
    'revo-run-script-event-receipt/v1',
    runId,
    operation,
    attempt,
    emissionOrdinal,
  ]);

export const operationReceiptId = (runId: string, operation: string, ordinal = 1): string =>
  identifier('opr_', ['revo-run-operation-observation-receipt/v1', runId, operation, ordinal]);

export const recoveryReceiptId = (runId: string, operation: string, ordinal = 1): string =>
  identifier('orr_', ['revo-run-operation-recovery-receipt/v1', runId, operation, ordinal]);

export const retryStartReceiptId = (runId: string, operation: string, ordinal: number): string =>
  identifier('ors_', ['revo-run-operation-retry-start-receipt/v1', runId, operation, ordinal]);

export const attemptDispatchArbitrationWorkflowId = (
  executionId: string,
  attempt: string,
): string =>
  identifier('arg_', ['revo-run-attempt-dispatch-arbitration-workflow/v1', executionId, attempt]);

export const attemptDispatchArbitrationIdentityToken = (
  executionId: string,
  attempt: string,
): string =>
  identifier('art_', ['revo-run-attempt-dispatch-arbitration-token/v1', executionId, attempt]);
