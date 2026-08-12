import { describe, expect, it } from 'vitest';

import {
  parseExecutionReservation,
  parseRunCoordinatorMessage,
} from '../../src/validation/run-coordinator-message.validator.js';

const digest = 'a'.repeat(43);
const attemptId = `at1_${digest}`;
const scopeWorkflowId = `rr:scope:v1:sc1_${digest}`;
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
        event: { type: 'parallel.joinFailed', data: eventIdentity },
      }),
    ).toStrictEqual({
      kind: 'event',
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
      parseRunCoordinatorMessage({ kind: 'scopeRegistered', workflowId: scopeWorkflowId }),
    ).toStrictEqual({ kind: 'scopeRegistered', workflowId: scopeWorkflowId });
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
      ).toThrow('Run coordinator received an invalid message.');
      expect(() =>
        parseExecutionReservation({ attemptId: invalidAttemptId, granted: true }),
      ).toThrow('Run execution received an invalid reservation.');
    },
  );

  it.each([
    'workflow_01',
    `sc1_${digest}`,
    `rr:scope:sc1_${digest}`,
    `rr:scope:v2:sc1_${digest}`,
    `rr:scope:v3:sc1_${digest}`,
    'rr:run:v1:Run_1',
    `rr:scope:v1:ni1_${digest}`,
    'rr:scope:v1:sc1_short',
  ])('rejects invalid scope workflow ID %s', (invalidWorkflowId) => {
    for (const message of [
      { kind: 'reserveExecution', attemptId, replyWorkflowId: invalidWorkflowId },
      { kind: 'scopeRegistered', workflowId: invalidWorkflowId },
      { kind: 'scopeSettled', workflowId: invalidWorkflowId },
    ]) {
      expect(() => parseRunCoordinatorMessage(message)).toThrow(
        'Run coordinator received an invalid message.',
      );
    }
  });

  it('rejects malformed nested events', () => {
    expect(() =>
      parseRunCoordinatorMessage({ kind: 'event', event: { type: 42, data: eventIdentity } }),
    ).toThrow('Run coordinator received an invalid message.');
  });

  it('rejects additional properties', () => {
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'scopeSettled',
        workflowId: scopeWorkflowId,
        unexpected: true,
      }),
    ).toThrow('Run coordinator received an invalid message.');
  });

  it('rejects error codes outside the identifier grammar', () => {
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'event',
        event: {
          type: 'pipeline.invalidState',
          data: { ...eventIdentity, errorCode: 'invalid/code' },
        },
      }),
    ).toThrow('Run coordinator received an invalid message.');
  });
});
