import { DBOS, DBOSClient, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import type { PipelineSourcePackage } from '@revisium/revo-pipeline';
import { createRevoScripts } from '@revisium/revo-scripts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { admitRun } from '../../src/admission/admit-run.js';
import { unavailableAgentPort } from '../../src/composition/agent-port.js';
import { RunHostReadinessFence } from '../../src/composition/readiness-fence.js';
import type { RunSnapshot } from '../../src/contracts/observation.js';
import { DefaultRunManager } from '../../src/manager/run-manager.js';

const defaultRunId = 'rn1-fatal-status';
const defaultWorkflowId = `revo-run:${defaultRunId}`;
const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const completeV1Pipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'fatal-known-v1',
  entryModule: 'main',
  maximumTotalActivities: 1,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'end',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [{ kind: 'end', id: 'end', outcome: 'ok', output: {} }],
      },
    },
  ],
};

const completeV1Snapshot = async () => {
  const scripts = createRevoScripts({
    host: {
      resources: { inspect: async () => undefined },
      workspaces: {
        inspect: async () => undefined,
        acquire: async () => {
          throw new Error('Known v1 snapshot does not acquire a workspace.');
        },
      },
      credentials: {
        inspect: async () => undefined,
        acquire: async () => {
          throw new Error('Known v1 snapshot does not acquire a credential.');
        },
      },
    },
  });
  return await admitRun(
    {
      runId: 'known-v1-persisted-run',
      pipeline: completeV1Pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: {} },
      },
      input: {},
    },
    { fence: new RunHostReadinessFence(), agents: unavailableAgentPort, scripts },
  );
};

const fatalStatus = (
  status: 'ERROR' | 'CANCELLED' | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
): WorkflowStatus => ({
  workflowID: defaultWorkflowId,
  workflowName: 'revo-run.kernel-host/v1',
  workflowClassName: '',
  applicationID: 'revo-run-test',
  status,
  createdAt: 1,
  updatedAt: 2,
  priority: 0,
});

const runStatus = (candidateRunId: string, createdAt: number): WorkflowStatus => ({
  ...fatalStatus('ERROR'),
  workflowID: `revo-run:${candidateRunId}`,
  createdAt,
  updatedAt: createdAt,
});

const options = {
  agents: unavailableAgentPort,
  database: { url: 'postgresql://unused' },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('fatal status projection never acquires a workspace');
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('fatal status projection never acquires a credential');
      },
    },
  },
} as const;

const unstartedManager = (): DefaultRunManager => new DefaultRunManager(options);

const manager = (): DefaultRunManager => {
  const value = unstartedManager();
  Reflect.set(value, 'lifecycle', 'running');
  return value;
};

afterEach(() => vi.restoreAllMocks());

describe('RN1 fatal DBOS workflow projection', () => {
  it('normalizes a DBOS read failure instead of exposing the provider exception', async () => {
    vi.spyOn(DBOS, 'getWorkflowStatus').mockRejectedValue(new Error('database password leaked'));

    await expect(manager().getRun(defaultRunId)).rejects.toMatchObject({
      code: 'run_read_failed',
      details: { runId: defaultRunId, operation: 'get_run' },
    });
  });

  it('rejects malformed durable details instead of projecting an unvalidated public value', async () => {
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue({
      ...fatalStatus('ERROR'),
      status: 'PENDING',
    });
    vi.spyOn(DBOS, 'getEvent').mockResolvedValue({
      schemaVersion: 'run-details/v1',
      runId: defaultRunId,
      status: 'running',
      leaked: 'raw durable field',
    });

    await expect(manager().getRun(defaultRunId)).rejects.toMatchObject({
      code: 'run_read_failed',
      details: { runId: defaultRunId, operation: 'get_run' },
    });
  });

  it('classifies a malformed completed DBOS result as a fixed read failure', async () => {
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue({
      ...fatalStatus('ERROR'),
      status: 'SUCCESS',
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately incomplete DBOS handle at the public durable-data boundary.
    vi.spyOn(DBOS, 'retrieveWorkflow').mockReturnValue({
      getResult: async () => ({ leaked: 'malformed completed workflow result' }),
    } as never);

    await expect(manager().getRun(defaultRunId)).rejects.toMatchObject({
      code: 'run_read_failed',
      details: { runId: defaultRunId, operation: 'get_run' },
    });
    await expect(manager().getRunDetails(defaultRunId)).rejects.toMatchObject({
      code: 'run_read_failed',
      details: { runId: defaultRunId, operation: 'get_details' },
    });
  });

  it('rejects an incompatible nonterminal persisted root before DBOS launch', async () => {
    const launch = vi.spyOn(DBOS, 'launch');
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the DBOS compatibility preflight test.');
    }
    const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
    vi.spyOn(client, 'listWorkflows').mockResolvedValue([
      {
        ...fatalStatus('ERROR'),
        status: 'PENDING',
        input: [{ persistenceVersion: 2 }],
      },
    ]);
    vi.spyOn(DBOSClient, 'create').mockResolvedValue(client);

    await expect(unstartedManager().start()).rejects.toMatchObject({
      code: 'manager_start_failed',
      details: { operation: 'host_initialization' },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects an incomplete v1 persisted root before DBOS launch', async () => {
    const launch = vi.spyOn(DBOS, 'launch');
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the DBOS compatibility preflight test.');
    }
    const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
    vi.spyOn(client, 'listWorkflows').mockResolvedValue([
      {
        ...fatalStatus('ERROR'),
        status: 'PENDING',
        input: [
          {
            persistenceVersion: 1,
            runId: 'incomplete-v1-persisted-run',
            admission: { token: 'immutable-admission-token' },
          },
        ],
      },
    ]);
    vi.spyOn(DBOSClient, 'create').mockResolvedValue(client);

    await expect(unstartedManager().start()).rejects.toMatchObject({
      code: 'manager_start_failed',
      details: { operation: 'host_initialization' },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects every nonterminal root identity/name mismatch before DBOS launch', async () => {
    const launch = vi.spyOn(DBOS, 'launch');
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the DBOS compatibility preflight test.');
    }
    const snapshot = await completeV1Snapshot();
    const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
    vi.spyOn(client, 'listWorkflows').mockResolvedValue([
      {
        ...fatalStatus('ERROR'),
        status: 'PENDING',
        workflowID: 'revo-run:legacy-root',
        workflowName: 'revo-run.legacy-workflow/v1',
        input: [{ ...snapshot, runId: 'legacy-root' }],
      },
      {
        ...fatalStatus('ERROR'),
        status: 'PENDING',
        workflowID: 'not-a-run-root',
        workflowName: 'revo-run.kernel-host/v1',
        input: [snapshot],
      },
    ]);
    vi.spyOn(DBOSClient, 'create').mockResolvedValue(client);

    await expect(unstartedManager().start()).rejects.toMatchObject({
      code: 'manager_start_failed',
      details: { operation: 'host_initialization' },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('treats a fresh DBOS system database as empty before DBOS initializes its tables', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the fresh-system-database preflight test.');
    }
    const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
    const missingWorkflowTable = Object.assign(
      new Error('relation "dbos.workflow_status" does not exist'),
      { code: '42P01' },
    );
    vi.spyOn(client, 'listWorkflows').mockRejectedValue(missingWorkflowTable);
    vi.spyOn(DBOSClient, 'create').mockResolvedValue(client);
    const launch = vi.spyOn(DBOS, 'launch').mockResolvedValue(undefined);
    vi.spyOn(DBOS, 'getEventDispatchState').mockResolvedValue(undefined);
    vi.spyOn(DBOS, 'shutdown').mockResolvedValue(undefined);
    const value = new DefaultRunManager({ ...options, database: { url: databaseUrl } });

    await expect(value.start()).resolves.toBeUndefined();
    expect(launch).toHaveBeenCalledOnce();
    await expect(value.stop()).resolves.toBeUndefined();
  });

  it('allows a known v1 nonterminal root through the compatibility scan before launch', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the DBOS compatibility preflight test.');
    }
    const snapshot = await completeV1Snapshot();
    const client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
    vi.spyOn(client, 'listWorkflows').mockResolvedValue([
      {
        ...fatalStatus('ERROR'),
        status: 'PENDING',
        workflowID: `revo-run:${snapshot.runId}`,
        input: [snapshot],
      },
    ]);
    vi.spyOn(DBOSClient, 'create').mockResolvedValue(client);
    const value = new DefaultRunManager({ ...options, database: { url: databaseUrl } });

    await expect(value.start()).resolves.toBeUndefined();
    await expect(value.stop()).resolves.toBeUndefined();
  });

  it.each(['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const)(
    'projects DBOS %s as terminal public execution failure in every read path',
    async (status) => {
      vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(fatalStatus(status));
      vi.spyOn(DBOS, 'listWorkflows').mockResolvedValue([fatalStatus(status)]);
      const value = manager();

      await expect(value.getRun(defaultRunId)).resolves.toMatchObject({
        status: 'failed',
        terminal: { kind: 'failed', error: { code: 'revo.run.execution_failed' } },
      });
      await expect(value.getRunDetails(defaultRunId)).resolves.toMatchObject({
        status: 'failed',
        terminal: { kind: 'failed', error: { code: 'revo.run.execution_failed' } },
        activities: [],
      });
      await expect(value.waitForTerminal(defaultRunId)).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(value.listRuns()).resolves.toMatchObject({
        items: [expect.objectContaining({ runId: defaultRunId, status: 'failed' })],
      });
    },
  );

  it('passes an ordered ISO creation window to the DBOS list boundary and rejects invalid ranges', async () => {
    const list = vi.spyOn(DBOS, 'listWorkflows').mockResolvedValue([]);
    const value = manager();

    await expect(
      value.listRuns({
        createdAtFrom: '2026-01-01T00:00:00.000Z',
        createdAtTo: '2026-01-02T00:00:00.000Z',
      }),
    ).resolves.toStrictEqual({ items: [], nextOffset: null });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-02T00:00:00.000Z',
      }),
    );
    await expect(value.listRuns({ createdAtFrom: 'not-a-date' })).rejects.toMatchObject({
      code: 'invalid_list_runs_filter',
    });
    await expect(
      value.listRuns({ createdAtFrom: '2026-02-30T00:00:00.000Z' }),
    ).rejects.toMatchObject({
      code: 'invalid_list_runs_filter',
    });
    await expect(
      value.listRuns({
        createdAtFrom: '2026-01-02T00:00:00.000Z',
        createdAtTo: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'invalid_list_runs_filter' });
    const listRuns = Reflect.get(value, 'listRuns');
    if (typeof listRuns !== 'function') {
      throw new Error('Expected the public list-runs method.');
    }
    await expect(Reflect.apply(listRuns, value, [{ statuses: ['unknown'] }])).rejects.toMatchObject(
      {
        code: 'invalid_list_runs_filter',
      },
    );
  });

  it('applies status filtering before offset pagination and keeps the documented stable order', async () => {
    const workflows = [runStatus('run-z', 10), runStatus('run-a', 10), runStatus('run-b', 11)];
    vi.spyOn(DBOS, 'listWorkflows').mockResolvedValue(workflows);
    vi.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async (candidateWorkflowId) => {
      return workflows.find((workflow) => workflow.workflowID === candidateWorkflowId) ?? null;
    });

    await expect(
      manager().listRuns({ statuses: ['failed'], offset: 1, limit: 1 }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ runId: 'run-a', status: 'failed' })],
      nextOffset: 2,
    });
  });

  it('classifies foreign and ahead cursors and rejects a subscription sequence regression', async () => {
    const observedRunId = 'run-observe';
    const status: WorkflowStatus = {
      ...fatalStatus('ERROR'),
      workflowID: `revo-run:${observedRunId}`,
      status: 'PENDING',
    };
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(status);
    vi.spyOn(DBOS, 'getEvent').mockImplementation(async (_workflowId, key) => {
      return key === 'revo-run.events-high-water' ? 2 : null;
    });
    const stream = async function* () {
      for (const sequence of [1, 2, 3, 3]) {
        yield {
          schemaVersion: 'run-event/v1' as const,
          runId: observedRunId,
          sequence,
          cursor: `${observedRunId}:${sequence}`,
          occurredAt: '2026-08-26T18:00:00.000Z',
          payload: { type: 'run.admitted' as const },
        };
      }
    };
    vi.spyOn(DBOS, 'readStream').mockImplementation(() => stream());
    const value = manager();

    await expect(value.getRunEvents(observedRunId, { after: 'other-run:1' })).rejects.toMatchObject(
      {
        code: 'run_event_cursor_invalid',
        details: { runId: observedRunId, reason: 'foreign' },
      },
    );
    await expect(
      value.getRunEvents(observedRunId, { after: `${observedRunId}:3` }),
    ).rejects.toMatchObject({
      code: 'run_event_cursor_invalid',
      details: { runId: observedRunId, reason: 'ahead' },
    });
    const observed: unknown[] = [];
    const collect = async (): Promise<void> => {
      for await (const event of value.subscribeRunEvents(observedRunId, {
        after: `${observedRunId}:1`,
      })) {
        observed.push(event);
      }
    };
    await expect(collect()).rejects.toMatchObject({ code: 'run_event_subscription_failed' });
    expect(observed).toMatchObject([{ sequence: 2 }, { sequence: 3 }]);
  });

  it('reports the exact retained recovery attempts when waiting cannot reach a terminal result', async () => {
    const value = manager();
    const recoverySnapshot = {
      schemaVersion: 'run-snapshot/v1',
      runId: defaultRunId,
      status: 'recovery_required',
      createdAt: '2026-08-26T18:00:00.000Z',
      updatedAt: '2026-08-26T18:00:00.000Z',
      terminal: null,
    } satisfies RunSnapshot;
    vi.spyOn(value, 'getRun').mockResolvedValue(recoverySnapshot);
    vi.spyOn(value, 'getRunDetails').mockResolvedValue({
      ...recoverySnapshot,
      schemaVersion: 'run-details/v1',
      activities: [],
      operations: [],
      attempts: [],
      waits: [],
      gates: [],
      recovery: [
        {
          operationId: 'op_1',
          attemptId: 'att_1',
          executor: 'script',
          reasonCode: 'outcome_unknown',
          since: '2026-08-26T18:00:00.000Z',
        },
      ],
    });

    await expect(value.waitForTerminal(defaultRunId)).rejects.toMatchObject({
      code: 'run_recovery_required',
      details: { runId: defaultRunId, attempts: [{ operationId: 'op_1', attemptId: 'att_1' }] },
    });
  });
});
