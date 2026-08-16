import { describe, expect, it, vi } from 'vitest';

import { RunManagerError } from '../../src/index.js';
import type { RunEvent } from '../../src/index.js';
import { RunManager } from '../../src/manager/run-manager.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const runtime = (overrides: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) => ({
  cancelRun: async () => Promise.reject(new Error('not used')),
  start: async () => undefined,
  stop: async () => undefined,
  startRun: async () => undefined,
  getRun: async () => undefined,
  listRuns: async () => ({ items: [] }),
  resolveUnknownOutcome: async () => Promise.reject(new Error('not used')),
  answerGate: async () => Promise.reject(new Error('not used')),
  getRunDetails: async () => undefined,
  getRunEvents: async () => ({ items: [], hasMore: false }),
  subscribeRunEvents: async function* () {},
  waitForTerminal: async () => Promise.reject(new RunManagerError('run_not_found')),
  ...overrides,
});

describe('run manager error boundary', () => {
  it('uses typed lifecycle errors without leaking runtime messages or causes', async () => {
    const manager = new RunManager(
      runtime({ start: async () => Promise.reject(new Error('database secret')) }),
    );

    const error = await manager.start().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunManagerError);
    expect(error).toMatchObject({
      code: 'manager_start_failed',
      message: 'Run manager failed to start.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('database secret');
  });

  it('maps the same typed lifecycle error for concurrent callers', async () => {
    const manager = new RunManager(
      runtime({ start: async () => Promise.reject(new Error('database secret')) }),
    );

    const results = await Promise.allSettled([manager.start(), manager.start()]);

    expect(
      results.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof RunManagerError &&
          result.reason.code === 'manager_start_failed',
      ),
    ).toBe(true);
  });

  it('maps read failures and validates manager state through the same error contract', async () => {
    const manager = new RunManager(
      runtime({ getRun: async () => Promise.reject(new Error('DBOS read failed')) }),
    );

    await expect(manager.getRun('run-1')).rejects.toMatchObject({ code: 'manager_not_started' });
    await manager.start();
    await expect(manager.getRun('run-1')).rejects.toMatchObject({
      code: 'run_read_failed',
      message: 'Run could not be read.',
    });
  });

  it('preserves typed observation failures from the runtime boundary', async () => {
    const notFound = async () => Promise.reject(new RunManagerError('run_not_found'));
    const manager = new RunManager(runtime({ getRun: notFound, getRunDetails: notFound }));
    await manager.start();

    await expect(manager.getRun('Run_1')).rejects.toMatchObject({ code: 'run_not_found' });
    await expect(manager.getRunDetails('Run_1')).rejects.toMatchObject({ code: 'run_not_found' });
  });

  it.each([null, undefined, 42, '', {}, []])(
    'rejects invalid read API run IDs before reaching DBOS: %j',
    async (runId) => {
      const getRun = vi.fn<(runId: string) => Promise<undefined>>(async () => undefined);
      const getRunDetails = vi.fn<(runId: string) => Promise<undefined>>(async () => undefined);
      const subscribeRunEvents = vi.fn<(runId: string) => AsyncGenerator<RunEvent>>(
        async function* () {},
      );
      const manager = new RunManager(runtime({ getRun, getRunDetails, subscribeRunEvents }));
      await manager.start();
      const argument = { runId: 'valid' };
      Object.defineProperty(argument, 'runId', { value: runId });

      await expect(manager.getRun(argument.runId)).rejects.toMatchObject({
        code: 'invalid_run_id',
      });
      await expect(manager.getRunDetails(argument.runId)).rejects.toMatchObject({
        code: 'invalid_run_id',
      });
      expect(() => manager.subscribeRunEvents(argument.runId)).toThrowError(
        expect.objectContaining({ code: 'invalid_run_id' }),
      );
      expect(getRun).not.toHaveBeenCalled();
      expect(getRunDetails).not.toHaveBeenCalled();
      expect(subscribeRunEvents).not.toHaveBeenCalled();
    },
  );

  it.each(['run:reserved', '1run', `r${'x'.repeat(128)}`])(
    'rejects start run IDs outside the public contract before DBOS: %s',
    async (runId) => {
      const startRun = vi.fn<(runId: string) => Promise<void>>(async () => undefined);
      const manager = new RunManager(runtime({ startRun }));
      await manager.start();

      await expect(
        manager.startRun({ runId, executionPlan: terminalExecutionPlan(), input: null }),
      ).rejects.toMatchObject({ code: 'invalid_run_id' });
      expect(startRun).not.toHaveBeenCalled();
    },
  );

  it('redacts failures raised while consuming the event iterator', async () => {
    const manager = new RunManager(
      runtime({
        subscribeRunEvents: async function* () {
          const events: readonly RunEvent[] = [];
          for (const event of events) {
            yield event;
          }
          throw new Error('stream cursor and database secret');
        },
      }),
    );
    await manager.start();

    const collect = async () => {
      for await (const event of manager.subscribeRunEvents('run-1')) {
        void event;
      }
    };

    await expect(collect()).rejects.toMatchObject({
      code: 'run_event_subscription_failed',
      message: 'Run event subscription failed.',
    });
  });
});
