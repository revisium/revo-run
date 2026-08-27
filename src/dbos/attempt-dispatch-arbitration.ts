import { DBOS } from '@dbos-inc/dbos-sdk';

import {
  attemptDispatchArbitrationIdentityToken,
  attemptDispatchArbitrationWorkflowId,
} from '../operations/identities.js';

export const attemptDispatchArbitrationWorkflowName = 'revo-run.attempt-dispatch-arbitration/v1';

export interface AttemptDispatchArbitrationRecordV1 {
  readonly schemaVersion: 'attempt-dispatch-arbitration/v1';
  readonly executionId: string;
  readonly attemptId: string;
  readonly identityToken: string;
  readonly winner: 'dispatch_won' | 'cancel_won';
}

const isIdentity = (value: unknown, prefix: 'op_' | 'att_'): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

export const isAttemptDispatchArbitrationRecord = (
  value: unknown,
): value is AttemptDispatchArbitrationRecordV1 => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'executionId',
      'attemptId',
      'identityToken',
      'winner',
    ]) ||
    value.schemaVersion !== 'attempt-dispatch-arbitration/v1' ||
    !isIdentity(value.executionId, 'op_') ||
    !isIdentity(value.attemptId, 'att_') ||
    (value.winner !== 'dispatch_won' && value.winner !== 'cancel_won')
  ) {
    return false;
  }
  return (
    value.identityToken ===
    attemptDispatchArbitrationIdentityToken(value.executionId, value.attemptId)
  );
};

export const attemptDispatchArbitrationCandidate = (
  executionId: string,
  attemptId: string,
  winner: AttemptDispatchArbitrationRecordV1['winner'],
): AttemptDispatchArbitrationRecordV1 => ({
  schemaVersion: 'attempt-dispatch-arbitration/v1',
  executionId,
  attemptId,
  identityToken: attemptDispatchArbitrationIdentityToken(executionId, attemptId),
  winner,
});

const attemptDispatchArbitrationWorkflow = async (
  input: AttemptDispatchArbitrationRecordV1,
): Promise<AttemptDispatchArbitrationRecordV1> => {
  if (!isAttemptDispatchArbitrationRecord(input)) {
    throw new Error('Attempt dispatch arbitration has an invalid durable input.');
  }
  return input;
};

export const registeredAttemptDispatchArbitrationWorkflow = DBOS.registerWorkflow(
  attemptDispatchArbitrationWorkflow,
  { name: attemptDispatchArbitrationWorkflowName },
);

export const arbitrateAttemptDispatch = async (
  candidate: unknown,
): Promise<AttemptDispatchArbitrationRecordV1> => {
  if (!isAttemptDispatchArbitrationRecord(candidate)) {
    throw new Error('Attempt dispatch arbitration candidate is invalid.');
  }
  const workflowID = attemptDispatchArbitrationWorkflowId(
    candidate.executionId,
    candidate.attemptId,
  );
  const handle = await DBOS.startWorkflow(registeredAttemptDispatchArbitrationWorkflow, {
    workflowID,
  })(candidate);
  if (handle.workflowID !== workflowID) {
    throw new Error('Attempt dispatch arbitration returned an unexpected workflow identity.');
  }
  const stored = await handle.getResult();
  if (
    !isAttemptDispatchArbitrationRecord(stored) ||
    stored.executionId !== candidate.executionId ||
    stored.attemptId !== candidate.attemptId
  ) {
    throw new Error('Attempt dispatch arbitration returned an invalid durable result.');
  }
  return stored;
};
