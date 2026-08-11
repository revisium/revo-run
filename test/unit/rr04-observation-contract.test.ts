import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import {
  RunErrorSchema,
  RunEventCursorSchema,
  RunEventPageInputSchema,
  RunEventPageSchema,
  RunEventSubscriptionInputSchema,
  RunResultSchema,
  RunStatusSchema,
} from '../../src/index.js';
import { isListRunsInput } from '../../src/validation/list-runs.validator.js';
import { isWaitForTerminalInput } from '../../src/validation/wait-for-terminal.validator.js';

const CursorValidator = Schema.Compile(RunEventCursorSchema);
const PageInputValidator = Schema.Compile(RunEventPageInputSchema);
const PageValidator = Schema.Compile(RunEventPageSchema);
const SubscriptionInputValidator = Schema.Compile(RunEventSubscriptionInputSchema);
const RunStatusValidator = Schema.Compile(RunStatusSchema);
const RunResultValidator = Schema.Compile(RunResultSchema);
const RunErrorValidator = Schema.Compile(RunErrorSchema);

const terminalEvent = {
  cursor: 'Run_1:1',
  timestamp: '2026-08-11T00:00:00.000Z',
  type: 'run.completed',
  data: { outcome: 'completed' },
} as const;

describe('RR-04 observation schemas and live validators', () => {
  it('accepts only canonical positive-safe event cursors', () => {
    expect(CursorValidator.Check('Run_1:1')).toBe(true);
    expect(CursorValidator.Check(`Run_1:${Number.MAX_SAFE_INTEGER}`)).toBe(true);
    for (const cursor of [
      'Run_1:0',
      'Run_1:01',
      `Run_1:${Number.MAX_SAFE_INTEGER + 1}`,
      'Run_1:1.5',
      'run:segment:1',
    ]) {
      expect(CursorValidator.Check(cursor)).toBe(false);
    }
  });

  it('closes page and subscription inputs at their exact boundaries', () => {
    expect(PageInputValidator.Check({ limit: 1 })).toBe(true);
    expect(PageInputValidator.Check({ limit: 100, after: 'Run_1:1' })).toBe(true);
    expect(SubscriptionInputValidator.Check({ after: 'Run_1:1' })).toBe(true);
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: 1, extra: true },
      { after: 'Run_1:01' },
    ]) {
      expect(PageInputValidator.Check(input)).toBe(false);
    }
    expect(SubscriptionInputValidator.Check({ after: 'Run_1:1', extra: true })).toBe(false);
  });

  it('validates nested page events and rejects unapproved fields', () => {
    expect(PageValidator.Check({ items: [], hasMore: false })).toBe(true);
    expect(PageValidator.Check({ items: [], nextCursor: 'Run_1:1', hasMore: false })).toBe(false);
    expect(PageValidator.Check({ items: [terminalEvent], hasMore: false })).toBe(false);
    expect(
      PageValidator.Check({
        items: [terminalEvent],
        nextCursor: 'Run_1:1',
        hasMore: false,
      }),
    ).toBe(true);
    expect(
      PageValidator.Check({
        items: [{ ...terminalEvent, data: { outcome: 'completed', secret: 'leak' } }],
        nextCursor: 'Run_1:1',
        hasMore: false,
      }),
    ).toBe(false);
    expect(
      PageValidator.Check({
        items: [terminalEvent],
        nextCursor: 'Run_1:1',
        hasMore: false,
        total: 1,
      }),
    ).toBe(false);
    expect(
      PageValidator.Check({ items: [terminalEvent], nextCursor: 'Run_1:01', hasMore: true }),
    ).toBe(false);
  });

  it('keeps status, result, and redacted error unions exact', () => {
    for (const status of ['pending', 'running', 'succeeded', 'failed', 'cancelled']) {
      expect(RunStatusValidator.Check(status)).toBe(true);
    }
    expect(RunStatusValidator.Check('completed')).toBe(false);
    expect(RunResultValidator.Check({ outcome: 'completed' })).toBe(true);
    expect(RunResultValidator.Check({ outcome: 'completed', error: 'leak' })).toBe(false);
    expect(
      RunErrorValidator.Check({
        code: 'workflow_failed',
        message: 'Workflow execution failed.',
      }),
    ).toBe(true);
    expect(
      RunErrorValidator.Check({ code: 'workflow_failed', message: 'raw provider failure' }),
    ).toBe(false);
  });

  it('validates list Date objects, uniqueness, ranges, and exact properties', () => {
    expect(
      isListRunsInput({
        statuses: ['running', 'failed'],
        createdFrom: new Date(1),
        createdThrough: new Date(2),
        offset: 0,
        limit: 100,
      }),
    ).toBe(true);
    for (const input of [
      { statuses: [] },
      { statuses: ['running', 'running'] },
      { statuses: ['unknown'] },
      { createdFrom: new Date(Number.NaN) },
      { createdFrom: new Date(2), createdThrough: new Date(1) },
      { offset: -1 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 0 },
      { limit: 101 },
      { extra: true },
    ]) {
      expect(isListRunsInput(input)).toBe(false);
    }
  });

  it('accepts only a positive safe timeout and a live AbortSignal', () => {
    expect(isWaitForTerminalInput({ timeoutMs: 1 })).toBe(true);
    expect(
      isWaitForTerminalInput({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        signal: new AbortController().signal,
      }),
    ).toBe(true);
    for (const input of [
      { timeoutMs: 0 },
      { timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
      { timeoutMs: 1.5 },
      { signal: { aborted: false } },
      { extra: true },
    ]) {
      expect(isWaitForTerminalInput(input)).toBe(false);
    }
  });
});
