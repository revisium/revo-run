import { describe, expect, it } from 'vitest';

import {
  parseExecutionReservation,
  parseRunCoordinatorMessage,
} from '../../src/validation/run-coordinator-message.validator.js';

const digest = 'a'.repeat(43);
const attemptId = `at1_${digest}`;
const scopeWorkflowId = `rr:scope:sc1_${digest}`;
const eventIdentity = {
  scopeId: `sc1_${digest}`,
  authoredNodeId: `an1_${digest}`,
  nodeInstanceId: `ni1_${digest}`,
} as const;

describe('run coordinator message validation', () => {
  it('accepts durable coordinator messages and reservations', () => {
    expect(
      parseRunCoordinatorMessage({
        kind: 'event',
        workflowId: scopeWorkflowId,
        event: { type: 'parallel.joinFailed', data: eventIdentity },
      }),
    ).toStrictEqual({
      kind: 'event',
      workflowId: scopeWorkflowId,
      event: { type: 'parallel.joinFailed', data: eventIdentity },
    });
    expect(
      parseRunCoordinatorMessage({
        kind: 'reserveExecution',
        attemptId,
        replyWorkflowId: scopeWorkflowId,
      }),
    ).toStrictEqual({ kind: 'reserveExecution', attemptId, replyWorkflowId: scopeWorkflowId });
    expect(
      parseRunCoordinatorMessage({
        kind: 'scopeReady',
        workflowId: scopeWorkflowId,
        parentWorkflowId: 'rr:run:Run_1',
      }),
    ).toStrictEqual({
      kind: 'scopeReady',
      workflowId: scopeWorkflowId,
      parentWorkflowId: 'rr:run:Run_1',
    });
    expect(
      parseRunCoordinatorMessage({ kind: 'scopeSettled', workflowId: scopeWorkflowId }),
    ).toStrictEqual({ kind: 'scopeSettled', workflowId: scopeWorkflowId });
    expect(parseExecutionReservation({ attemptId, granted: true })).toStrictEqual({
      attemptId,
      granted: true,
    });
  });

  it.each(['attempt_01', `an1_${digest}`, 'at1_short'])(
    'rejects invalid attempt ID %s',
    (invalidAttemptId) => {
      expect(() =>
        parseRunCoordinatorMessage({
          kind: 'reserveExecution',
          attemptId: invalidAttemptId,
          replyWorkflowId: scopeWorkflowId,
        }),
      ).toThrow('Run coordinator message is invalid.');
      expect(() =>
        parseExecutionReservation({ attemptId: invalidAttemptId, granted: true }),
      ).toThrow('Execution reservation is invalid.');
    },
  );

  it.each([
    'workflow_01',
    `sc1_${digest}`,
    `foreign:scope:sc1_${digest}`,
    `rr:foreign:sc1_${digest}`,
    `rr:scope:foreign:sc1_${digest}`,
    'rr:run:Run_1',
    `rr:scope:ni1_${digest}`,
    'rr:scope:sc1_short',
  ])('rejects invalid scope workflow ID %s', (invalidWorkflowId) => {
    for (const message of [
      { kind: 'reserveExecution', attemptId, replyWorkflowId: invalidWorkflowId },
      { kind: 'scopeFinish', workflowId: invalidWorkflowId },
      { kind: 'scopeSettled', workflowId: invalidWorkflowId },
    ]) {
      expect(() => parseRunCoordinatorMessage(message)).toThrow(
        'Run coordinator message is invalid.',
      );
    }
  });

  it('rejects malformed nested events', () => {
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'event',
        workflowId: scopeWorkflowId,
        event: { type: 42, data: eventIdentity },
      }),
    ).toThrow('Run coordinator message is invalid.');
  });

  it('rejects additional properties', () => {
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'scopeSettled',
        workflowId: scopeWorkflowId,
        unexpected: true,
      }),
    ).toThrow('Run coordinator message is invalid.');
  });

  it('rejects error codes outside the identifier grammar', () => {
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'event',
        workflowId: scopeWorkflowId,
        event: {
          type: 'pipeline.invalidState',
          data: { ...eventIdentity, errorCode: 'invalid/code' },
        },
      }),
    ).toThrow('Run coordinator message is invalid.');
  });
});
