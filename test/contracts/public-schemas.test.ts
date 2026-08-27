import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  RunManagerErrorSchema,
  RunAttemptSnapshotSchema,
  RunEventSchema,
  RunGateSnapshotSchema,
  RunPublicFailureSchema,
  RunSnapshotSchema,
  RunWaitSnapshotSchema,
  SendSignalInputSchema,
  WaitForTerminalInputSchema,
} from '../../src/index.js';

describe('RN1 public runtime schemas', () => {
  it('couples terminal status to its terminal branch and rejects unknown fields', () => {
    const succeeded = {
      schemaVersion: 'run-snapshot/v1',
      runId: 'run_01K4Q7T9R2M8',
      status: 'succeeded',
      createdAt: '2026-08-26T18:00:00.000Z',
      updatedAt: '2026-08-26T18:00:00.000Z',
      terminal: { kind: 'succeeded', outcome: 'ok', output: {} },
    };

    expect(Check(RunSnapshotSchema, succeeded)).toBe(true);
    expect(Check(RunSnapshotSchema, { ...succeeded, status: 'failed' })).toBe(false);
    expect(Check(RunSnapshotSchema, { ...succeeded, legacy: true })).toBe(false);
  });

  it('keeps root event and interaction envelopes closed', () => {
    expect(
      Check(RunEventSchema, {
        schemaVersion: 'run-event/v1',
        runId: 'run_01K4Q7T9R2M8',
        sequence: 1,
        cursor: 'run_01K4Q7T9R2M8:1',
        occurredAt: '2026-08-26T18:00:00.000Z',
        payload: { type: 'run.admitted' },
      }),
    ).toBe(true);
    expect(
      Check(SendSignalInputSchema, {
        runId: 'run_01K4Q7T9R2M8',
        waitId: 'wait_1',
        signal: 'continue',
        actorId: 'user-1',
        ignored: true,
      }),
    ).toBe(false);
  });

  it('couples public manager error code and closed details branch', () => {
    expect(Check(RunManagerErrorSchema, { code: 'agent_runtime_unavailable', details: {} })).toBe(
      true,
    );
    expect(
      Check(RunManagerErrorSchema, {
        code: 'agent_runtime_unavailable',
        details: { requirementKey: 'private' },
      }),
    ).toBe(false);
  });

  it('couples every human-gate status to its only permitted resolution', () => {
    const pending = {
      gateId: 'gate_1',
      operationId: 'op_1',
      status: 'pending',
      subject: 'Approve',
      answers: ['approved'],
      openedAt: '2026-08-26T18:00:00.000Z',
      deadlineAt: null,
      resolution: null,
    };
    expect(Check(RunGateSnapshotSchema, pending)).toBe(true);
    expect(
      Check(RunGateSnapshotSchema, {
        ...pending,
        resolution: { kind: 'answer', answer: 'approved', actorId: 'reviewer-1', payload: null },
      }),
    ).toBe(false);
    expect(
      Check(RunGateSnapshotSchema, {
        ...pending,
        status: 'answered',
        resolution: { kind: 'cancelled' },
      }),
    ).toBe(false);
    expect(Check(RunGateSnapshotSchema, { ...pending, answers: ['approved', 'approved'] })).toBe(
      false,
    );
  });

  it('requires a completed timestamp for a cancelled activity attempt', () => {
    const cancelled = {
      attemptId: 'att_1',
      operationId: 'op_1',
      executor: 'script',
      ordinal: 1,
      status: 'cancelled',
      startedAt: '2026-08-26T18:00:00.000Z',
      finishedAt: '2026-08-26T18:00:01.000Z',
      failure: null,
    };
    expect(Check(RunAttemptSnapshotSchema, cancelled)).toBe(true);
    expect(Check(RunAttemptSnapshotSchema, { ...cancelled, finishedAt: null })).toBe(false);
  });

  it('exports the closed signal-wait snapshot schema from the package root', () => {
    expect(
      Check(RunWaitSnapshotSchema, {
        waitId: 'wait_1',
        operationId: 'op_1',
        kind: 'signal',
        status: 'pending',
        signal: 'continue',
        openedAt: '2026-08-26T18:00:00.000Z',
        deadlineAt: null,
      }),
    ).toBe(true);
  });

  it('rejects rollover timestamps, unsafe sequence values, and invalid JSON pointers', () => {
    const event = {
      schemaVersion: 'run-event/v1',
      runId: 'run_01K4Q7T9R2M8',
      sequence: 1,
      cursor: 'run_01K4Q7T9R2M8:1',
      occurredAt: '2026-08-26T18:00:00.000Z',
      payload: { type: 'run.admitted' },
    };
    expect(Check(RunEventSchema, { ...event, sequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(Check(RunEventSchema, { ...event, occurredAt: '2026-02-30T18:00:00.000Z' })).toBe(false);
    expect(
      Check(RunPublicFailureSchema, {
        code: 'failure',
        message: 'Failed.',
        path: 'not/a/json-pointer',
        details: null,
      }),
    ).toBe(false);
  });

  it('enforces bounded public details and validates the local abort signal option', () => {
    expect(
      Check(RunPublicFailureSchema, {
        code: 'failure',
        message: 'Failed.',
        path: null,
        details: { oversized: 'x'.repeat(65_536) },
      }),
    ).toBe(false);
    const controller = new AbortController();
    expect(Check(WaitForTerminalInputSchema, { signal: controller.signal })).toBe(true);
    expect(Check(WaitForTerminalInputSchema, { signal: {} })).toBe(false);
  });
});
