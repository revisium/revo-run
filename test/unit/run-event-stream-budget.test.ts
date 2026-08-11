import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  nowCalls: 0,
  writes: [] as unknown[],
  failNextWrite: false,
  async now(): Promise<number> {
    this.nowCalls += 1;
    return Date.UTC(2026, 7, 10, 12, 34, 56, 789);
  },
  async writeStream(_name: string, value: unknown): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('write failed');
    }
    this.writes.push(value);
  },
  async closeStream(): Promise<void> {},
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: dbos }));

import {
  assertRunEventBytesWithinBudget,
  assertRunEventCountWithinBudget,
  DbosRunEventStream,
  maximumStoredRunEventBytes,
  RunEventBudgetExceededError,
  serializedUtf8Bytes,
} from '../../src/dbos/streams/run-event-stream.js';

const digest = (character: string): string => character.repeat(43);
const draft = {
  type: 'pipeline.branchDefaulted',
  data: {
    scopeId: `sc1_${digest('a')}`,
    authoredNodeId: `an1_${digest('b')}`,
    nodeInstanceId: `ni1_${digest('c')}`,
  },
} as const;

describe('run event stream budgets', () => {
  beforeEach(() => {
    dbos.nowCalls = 0;
    dbos.writes = [];
    dbos.failNextWrite = false;
  });

  it('allows the count immediately below the limit', () => {
    expect(() => assertRunEventCountWithinBudget(99_999)).not.toThrow();
  });

  it.each([100_000, 100_001])('rejects count boundary %i', (accepted) => {
    expect(() => assertRunEventCountWithinBudget(accepted)).toThrowError(
      new RunEventBudgetExceededError('maximum_run_event_count_exceeded'),
    );
  });

  it.each([16_383, 16_384])('allows inclusive byte boundary %i', (bytes) => {
    expect(() => assertRunEventBytesWithinBudget(bytes)).not.toThrow();
  });

  it('rejects one byte above the limit', () => {
    expect(() => assertRunEventBytesWithinBudget(16_385)).toThrowError(
      new RunEventBudgetExceededError('maximum_run_event_bytes_exceeded'),
    );
  });

  it('uses the 16384-byte production limit for the complete serialized envelope', async () => {
    const expectedEvent = {
      cursor: 'run-1:1',
      timestamp: '2026-08-10T12:34:56.789Z',
      ...draft,
    } as const;
    const exactEnvelopeBytes = serializedUtf8Bytes(expectedEvent);

    expect(maximumStoredRunEventBytes).toBe(16_384);
    await expect(new DbosRunEventStream('run-1', exactEnvelopeBytes).append(draft)).resolves.toBe(
      undefined,
    );
    await expect(
      new DbosRunEventStream('run-2', exactEnvelopeBytes - 1).append(draft),
    ).rejects.toThrowError(new RunEventBudgetExceededError('maximum_run_event_bytes_exceeded'));
    expect(dbos.writes).toStrictEqual([expectedEvent]);
  });

  it('counts serialized UTF-8 bytes rather than JavaScript string code units', () => {
    const ascii = serializedUtf8Bytes({ value: 'a' });
    const multibyte = serializedUtf8Bytes({ value: 'é' });

    expect(multibyte).toBe(ascii + 1);
  });

  it('writes the exact envelope with root acceptance time and a run-scoped cursor', async () => {
    const events = new DbosRunEventStream('run-1');

    await events.append(draft);

    expect(dbos.writes).toStrictEqual([
      {
        cursor: 'run-1:1',
        timestamp: '2026-08-10T12:34:56.789Z',
        ...draft,
      },
    ]);
  });

  it('allocates a cursor and accepted count only after a durable write', async () => {
    const events = new DbosRunEventStream('run-1');
    dbos.failNextWrite = true;

    await expect(events.append(draft)).rejects.toThrow('write failed');
    await events.append(draft);

    expect(dbos.writes).toStrictEqual([
      expect.objectContaining({ cursor: 'run-1:1', type: 'pipeline.branchDefaulted' }),
    ]);
  });
});
