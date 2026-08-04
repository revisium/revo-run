import { afterEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => {
  const events = new Map<string, unknown>();
  let failSubmission = false;
  let missAdmission = false;
  const control = {
    events,
    ids: [] as string[],
    results: [] as Promise<unknown>[],
    getEvent: vi.fn<(id: string, key: string) => Promise<unknown>>(async (id, key) => {
      if (missAdmission) {
        missAdmission = false;
        return null;
      }
      return events.get(`${id}:${key}`) ?? null;
    }),
    launch: vi.fn<() => Promise<void>>(),
    setConfig: vi.fn<(configuration: unknown) => void>(),
    shutdown: vi.fn<() => Promise<void>>(),
    sleepms: vi.fn<(duration: number) => Promise<void>>(),
    failNextSubmission: () => {
      failSubmission = true;
    },
    missNextAdmission: () => {
      missAdmission = true;
    },
    shouldFailSubmission: () => {
      if (!failSubmission) return false;
      failSubmission = false;
      return true;
    },
    reset: () => {
      events.clear();
      control.ids.length = 0;
      control.results.length = 0;
      failSubmission = false;
      missAdmission = false;
      control.getEvent.mockClear();
      control.launch.mockReset();
      control.setConfig.mockClear();
      control.shutdown.mockReset();
      control.sleepms.mockReset();
    },
  };
  return control;
});

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    getEvent: dbos.getEvent,
    launch: dbos.launch,
    registerWorkflow: <Arguments extends unknown[], Result>(
      workflow: (...arguments_: Arguments) => Promise<Result>,
    ) => workflow,
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
    setConfig: dbos.setConfig,
    setEvent: async (key: string, value: unknown) => {
      const id = dbos.ids.at(-1);
      if (id) dbos.events.set(`${id}:${key}`, value);
    },
    shutdown: dbos.shutdown,
    sleepms: dbos.sleepms,
    startWorkflow:
      <Arguments extends unknown[], Result>(
        workflow: (...arguments_: Arguments) => Promise<Result>,
        options: { workflowID?: string },
      ) =>
      async (...arguments_: Arguments) => {
        if (dbos.shouldFailSubmission()) throw new Error('submission failed');
        if (options.workflowID) dbos.ids.push(options.workflowID);
        const result = workflow(...arguments_);
        dbos.results.push(result);
        void result.catch(() => undefined);
        return { getResult: () => result };
      },
  },
}));

import { RunManagerScenario } from '../support/run-manager-scenario.js';

let scenario: RunManagerScenario | undefined;
const arrangeScenario = (): RunManagerScenario => {
  scenario = new RunManagerScenario(dbos);
  return scenario;
};

afterEach(async () => {
  await scenario?.stop();
  scenario = undefined;
});

describe('run manager behavior', () => {
  it('rejects run admission before start', async () => {
    const manager = arrangeScenario();

    await expect(manager.startRun()).rejects.toThrow('not started');
  });

  it('retries launch and coalesces repeated successful starts', async () => {
    const manager = arrangeScenario();
    manager.failNextLaunch();

    await expect(manager.start()).rejects.toThrow('launch failed');
    await Promise.all([manager.start(), manager.start()]);

    expect(manager.launchCalls()).toBe(2);
    expect(manager.configurationCalls()).toEqual([
      [{ name: 'revo-run', systemDatabaseUrl: 'postgresql://test' }],
      [{ name: 'revo-run', systemDatabaseUrl: 'postgresql://test' }],
    ]);
  });

  it('assigns an ID and snapshots mutable admission data', async () => {
    const manager = arrangeScenario();
    await manager.start();
    const input = { nested: { value: 1 } };
    const planPin = { id: 'p', revision: '1', digest: 'd' };

    const admitted = await manager.startRunWith(planPin, input);
    input.nested.value = 2;
    planPin.id = 'changed';

    expect(admitted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(admitted).toMatchObject({ input: { nested: { value: 1 } }, planPin: { id: 'p' } });
    expect(Object.isFrozen(admitted.input)).toBe(true);
    await vi.waitFor(() => expect(manager.snapshot(admitted.id)?.status).toBe('succeeded'));
  });

  it('polls admission again after an event timeout without resubmitting', async () => {
    const manager = arrangeScenario();
    await manager.start();
    manager.missNextAdmission();

    const admitted = await manager.startRun();

    expect(manager.submittedWorkflowIds(admitted.id)).toHaveLength(1);
    await vi.waitFor(() => expect(manager.snapshot(admitted.id)?.status).toBe('succeeded'));
  });

  it.each(['pending', 'running', 'succeeded'] as const)(
    'retries %s projection with deterministic backoff',
    async (status) => {
      const manager = arrangeScenario();
      await manager.start();
      manager.failProjection(status, 2);

      const admitted = await manager.startRun();

      await vi.waitFor(() => expect(manager.snapshot(admitted.id)?.status).toBe('succeeded'));
      expect(manager.retryDelays()).toEqual([100, 200]);
    },
  );

  it('does not re-execute work or change outcome during terminal projection retries', async () => {
    const manager = arrangeScenario();
    await manager.start();
    manager.failProjection('succeeded', 2);
    manager.changeExecutorOutcomeDuringTerminalProjectionFailure();

    const admitted = await manager.startRun();

    await vi.waitFor(() => expect(manager.snapshot(admitted.id)?.status).toBe('succeeded'));
    expect(manager.latestSnapshot()).toMatchObject({ status: 'succeeded' });
    expect(manager.executorCalls()).toBe(3);
  });

  it('reports workflow submission failure', async () => {
    const manager = arrangeScenario();
    await manager.start();
    manager.failNextSubmission();

    await expect(manager.startRun()).rejects.toThrow('submission failed');
  });

  it('projects a failed run when the executor fails', async () => {
    const manager = arrangeScenario();
    await manager.start();
    manager.executorFails();

    const admitted = await manager.startRun();

    await vi.waitFor(() => expect(manager.snapshot(admitted.id)?.status).toBe('failed'));
  });

  it('projects an invalid compiled plan as a failed run', async () => {
    const manager = arrangeScenario();
    await manager.start();
    manager.useInvalidPlan();

    const admitted = await manager.startRun();

    await vi.waitFor(() =>
      expect(manager.snapshot(admitted.id)?.error).toContain('invalid compiled'),
    );
  });

  it('blocks operations after shutdown failure until shutdown retry succeeds', async () => {
    const manager = arrangeScenario();
    await manager.start();
    manager.failNextShutdown();

    await expect(manager.stop()).rejects.toThrow('shutdown failed');
    await expect(manager.start()).rejects.toThrow('shutdown state is uncertain');
    await expect(manager.startRun()).rejects.toThrow('not started');

    await Promise.all([manager.stop(), manager.stop()]);
    expect(manager.shutdownCalls()).toBe(2);
  });
});
