import { describe, expect, it } from 'vitest';

import {
  parseExecutionReservation,
  parseRunCoordinatorMessage,
} from '../../src/validation/run-coordinator-message.validator.js';

describe('run coordinator message validation', () => {
  it('accepts durable coordinator messages and reservations', () => {
    expect(
      parseRunCoordinatorMessage({
        kind: 'event',
        event: { type: 'parallel.joinFailed', path: 'main/review' },
      }),
    ).toStrictEqual({
      kind: 'event',
      event: { type: 'parallel.joinFailed', path: 'main/review' },
    });
    expect(parseExecutionReservation({ executionId: 'execution_01', granted: true })).toStrictEqual(
      { executionId: 'execution_01', granted: true },
    );
  });

  it('rejects malformed nested events', () => {
    expect(() => parseRunCoordinatorMessage({ kind: 'event', event: { type: 42 } })).toThrow(
      'Run coordinator received an invalid message.',
    );
  });

  it('rejects additional properties', () => {
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'scopeSettled',
        workflowId: 'workflow_01',
        unexpected: true,
      }),
    ).toThrow('Run coordinator received an invalid message.');
  });

  it('rejects error codes outside the identifier grammar', () => {
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'event',
        event: { type: 'pipeline.invalidState', errorCode: 'invalid/code' },
      }),
    ).toThrow('Run coordinator received an invalid message.');
  });
});
