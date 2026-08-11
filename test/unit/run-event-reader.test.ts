import type { ListWorkflowStepsOptions } from '@dbos-inc/dbos-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestStepInfo {
  readonly functionID: number;
  readonly name: string;
  readonly output: unknown;
  readonly error: Error | null;
  readonly childWorkflowID: string | null;
  readonly startedAtEpochMs?: number;
  readonly completedAtEpochMs?: number;
}

const dbos = vi.hoisted(() => ({
  listWorkflowSteps:
    vi.fn<
      (
        workflowId: string,
        options?: ListWorkflowStepsOptions,
      ) => Promise<TestStepInfo[] | undefined>
    >(),
  readStream: vi.fn<(workflowId: string, streamKey: string) => AsyncIterable<unknown>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import {
  dbosWriteStreamStepName,
  loadRunEventPage,
  subscribeToRunEvents,
} from '../../src/dbos/read-model/run-event-reader.js';

const runId = 'Run_1';

const step = (functionID: number, name = dbosWriteStreamStepName) => ({
  functionID,
  name,
  output: null,
  error: null,
  childWorkflowID: null,
});

const event = (sequence: number) => ({
  cursor: `${runId}:${sequence}`,
  timestamp: `2026-08-11T00:00:0${sequence}.000Z`,
  type: sequence === 3 ? 'run.completed' : 'nodeExecution.started',
  data:
    sequence === 3
      ? { outcome: 'completed' }
      : {
          scopeId: `sc1_${'a'.repeat(43)}`,
          authoredNodeId: `an1_${'b'.repeat(43)}`,
          nodeInstanceId: `ni1_${'c'.repeat(43)}`,
          attemptId: `at1_${'d'.repeat(43)}`,
          attemptOrdinal: 1,
        },
});

const stream = (values: readonly unknown[]) =>
  async function* () {
    yield* values;
  };

describe('finite DBOS run event history', () => {
  beforeEach(() => {
    dbos.listWorkflowSteps.mockReset();
    dbos.readStream.mockReset();
    dbos.listWorkflowSteps.mockResolvedValue([
      step(1),
      step(2),
      step(3),
      step(4, 'DBOS.closeStream'),
    ]);
    dbos.readStream.mockImplementation(stream([event(1), event(2), event(3)]));
  });

  it('pins the public DBOS write-stream step name used as the high-water mark', () => {
    expect(dbosWriteStreamStepName).toBe('DBOS.writeStream');
  });

  it('replays from zero, filters after exclusively, and returns an honest page', async () => {
    await expect(loadRunEventPage(runId, { after: `${runId}:1`, limit: 1 })).resolves.toEqual({
      items: [event(2)],
      nextCursor: `${runId}:2`,
      hasMore: true,
    });
  });

  it('returns the last item cursor on a final page and omits it only for an empty page', async () => {
    await expect(loadRunEventPage(runId, { after: `${runId}:1` })).resolves.toEqual({
      items: [event(2), event(3)],
      nextCursor: `${runId}:3`,
      hasMore: false,
    });
    await expect(loadRunEventPage(runId, { after: `${runId}:3` })).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });

  it.each([
    [undefined, [1, 2, 3]],
    [`${runId}:1`, [2, 3]],
    [`${runId}:2`, [3]],
    [`${runId}:3`, []],
  ] as const)('reconnects exclusively after every accepted cursor %s', async (after, sequences) => {
    const page = await loadRunEventPage(runId, after === undefined ? {} : { after });

    expect(page.items.map(({ cursor }) => cursor)).toEqual(
      sequences.map((sequence) => `${runId}:${sequence}`),
    );
  });

  it('rejects cross-run and future cursors with one typed code', async () => {
    await expect(loadRunEventPage(runId, { after: 'Other:1' })).rejects.toMatchObject({
      code: 'invalid_run_event_cursor',
    });
    await expect(loadRunEventPage(runId, { after: `${runId}:4` })).rejects.toMatchObject({
      code: 'invalid_run_event_cursor',
    });
  });

  it('fails on a stream/high-water disagreement', async () => {
    dbos.readStream.mockImplementation(stream([event(1), event(3)]));

    await expect(loadRunEventPage(runId, {})).rejects.toMatchObject({ code: 'run_read_failed' });
  });

  it('closes the snapshot-subscribe race and resumes exclusively', async () => {
    dbos.listWorkflowSteps.mockResolvedValue([step(1)]);
    dbos.readStream
      .mockImplementationOnce(stream([event(1)]))
      .mockImplementationOnce(stream([event(1), event(2), event(3)]));

    const observed = [];
    for await (const value of subscribeToRunEvents(runId, { after: `${runId}:1` })) {
      observed.push(value);
    }

    expect(observed).toEqual([event(2), event(3)]);
  });

  it('bounds retained history to the requested page near the event budget', async () => {
    const maximumSequence = 99_999;
    dbos.listWorkflowSteps.mockImplementation(
      async (_workflowId, { limit = 100, offset = 0 } = {}) =>
        Array.from({ length: Math.min(limit, maximumSequence - offset) }, (_, index) =>
          step(offset + index + 1),
        ),
    );
    dbos.readStream.mockImplementation(async function* () {
      for (let sequence = 1; sequence <= maximumSequence; sequence += 1) {
        yield {
          ...event(1),
          cursor: `${runId}:${sequence}`,
          timestamp: '2026-08-11T00:00:00.000Z',
        };
      }
    });

    const page = await loadRunEventPage(runId, {
      after: `${runId}:${maximumSequence - 2}`,
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(`${runId}:${maximumSequence}`);
    expect(page.hasMore).toBe(false);
  }, 20_000);
});
