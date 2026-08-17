import { describe, expect, it, vi } from 'vitest';

import type {
  AnswerGateInput,
  ExecutionPlan,
  CancelRunInput,
  JsonValue,
  ListRunsInput,
  RunEvent,
  RunEventPage,
  RunEventPageInput,
  RunEventSubscriptionInput,
  RunPage,
  ResolveUnknownOutcomeInput,
  RunCommandReceipt,
  RunSnapshot,
  WaitForTerminalInput,
} from '../../src/index.js';
import { RunManager } from '../../src/manager/run-manager.js';

const observationRuntime = () => ({
  cancelRun: vi.fn<(input: CancelRunInput) => Promise<RunCommandReceipt>>(async () => {
    throw new Error('not used');
  }),
  getRun: vi.fn<(runId: string) => Promise<RunSnapshot | undefined>>(async () => undefined),
  getRunDetails: vi.fn<(runId: string) => Promise<undefined>>(async () => undefined),
  getRunEvents: vi.fn<(runId: string, input: RunEventPageInput) => Promise<RunEventPage>>(
    async () => ({ hasMore: false, items: [] }),
  ),
  listRuns: vi.fn<(input: ListRunsInput) => Promise<RunPage>>(async () => ({ items: [] })),
  start: vi.fn<() => Promise<void>>(async () => undefined),
  startRun: vi.fn<(runId: string, executionPlan: ExecutionPlan, input: JsonValue) => Promise<void>>(
    async () => undefined,
  ),
  resolveUnknownOutcome: vi.fn<(input: ResolveUnknownOutcomeInput) => Promise<RunCommandReceipt>>(
    async () => {
      throw new Error('not used');
    },
  ),
  answerGate: vi.fn<(input: AnswerGateInput) => Promise<RunCommandReceipt>>(async () => {
    throw new Error('not used');
  }),
  stop: vi.fn<() => Promise<void>>(async () => undefined),
  subscribeRunEvents: vi.fn<
    (runId: string, input: RunEventSubscriptionInput) => AsyncGenerator<RunEvent>
  >(async function* () {}),
  waitForTerminal: vi.fn<
    (runId: string, input: WaitForTerminalInput, managerSignal: AbortSignal) => Promise<RunSnapshot>
  >(async () => {
    throw new Error('not used');
  }),
});

describe('public observation input contract', () => {
  it.each([
    ['an empty status filter', { statuses: [] }],
    [
      'an inverted creation window',
      {
        createdFrom: new Date('2026-08-12T00:00:00.000Z'),
        createdThrough: new Date('2026-08-11T00:00:00.000Z'),
      },
    ],
  ] as const)('rejects %s before querying DBOS', async (_caseName, input) => {
    const adapter = observationRuntime();
    const manager = new RunManager(adapter);
    await manager.start();

    await expect(manager.listRuns(input)).rejects.toMatchObject({
      code: 'invalid_list_runs_input',
    });
    expect(adapter.listRuns).not.toHaveBeenCalled();
  });

  it('rejects a malformed page cursor before reading the stream', async () => {
    const adapter = observationRuntime();
    const manager = new RunManager(adapter);
    await manager.start();

    await expect(manager.getRunEvents('Run_1', { after: 'Run_1:01' })).rejects.toMatchObject({
      code: 'invalid_run_event_cursor',
    });
    expect(adapter.getRunEvents).not.toHaveBeenCalled();
  });

  it('rejects a zero-position cursor before subscribing to the stream', async () => {
    const adapter = observationRuntime();
    const manager = new RunManager(adapter);
    await manager.start();

    expect(() => manager.subscribeRunEvents('Run_1', { after: 'Run_1:0' })).toThrowError(
      expect.objectContaining({ code: 'invalid_run_event_cursor' }),
    );
    expect(adapter.subscribeRunEvents).not.toHaveBeenCalled();
  });

  it('rejects a cursor owned by another run before subscribing to the stream', async () => {
    const adapter = observationRuntime();
    const manager = new RunManager(adapter);
    await manager.start();

    expect(() => manager.subscribeRunEvents('Run_1', { after: 'Other:1' })).toThrowError(
      expect.objectContaining({ code: 'invalid_run_event_cursor' }),
    );
    expect(adapter.subscribeRunEvents).not.toHaveBeenCalled();
  });

  it('rejects extra subscription fields as subscription input, not as a cursor', async () => {
    const adapter = observationRuntime();
    const manager = new RunManager(adapter);
    await manager.start();

    const extra: RunEventSubscriptionInput & { readonly limit: number } = { limit: 10 };
    expect(() => manager.subscribeRunEvents('Run_1', extra)).toThrowError(
      expect.objectContaining({ code: 'invalid_run_event_subscription_input' }),
    );
    expect(adapter.subscribeRunEvents).not.toHaveBeenCalled();
  });

  it('rejects an invalid event-page limit before reading the stream', async () => {
    const adapter = observationRuntime();
    const manager = new RunManager(adapter);
    await manager.start();

    await expect(manager.getRunEvents('Run_1', { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_run_event_page_input',
    });
    expect(adapter.getRunEvents).not.toHaveBeenCalled();
  });

  it('rejects an invalid terminal-wait timeout before calling the runtime', async () => {
    const adapter = observationRuntime();
    const manager = new RunManager(adapter);
    await manager.start();

    await expect(manager.waitForTerminal('Run_1', { timeoutMs: 0 })).rejects.toMatchObject({
      code: 'invalid_wait_for_terminal_input',
    });
    expect(adapter.waitForTerminal).not.toHaveBeenCalled();
  });

  it('aborts a pending subscription next when its captured manager lifecycle stops', async () => {
    const adapter = observationRuntime();
    adapter.subscribeRunEvents.mockImplementation(async function* () {
      yield await new Promise<RunEvent>(() => undefined);
    });
    const manager = new RunManager(adapter);
    await manager.start();
    const iterator = manager.subscribeRunEvents('Run_1')[Symbol.asyncIterator]();
    const pending = iterator.next();

    await expect(manager.stop()).resolves.toBeUndefined();
    await expect(pending).rejects.toMatchObject({ code: 'run_event_subscription_failed' });
  });
});
