import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { Check } from 'typebox/value';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RunDetailsSchema,
  RunSnapshotSchema,
  createRunManager,
  type PipelineSourcePackage,
  type RunManager,
} from '../../src/index.js';
import { assertRecoveryObservation, recoveryScenario } from '../support/rn1-recovery-matrix.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const terminalPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-terminal',
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
        entry: 'done',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [{ kind: 'end', id: 'done', outcome: 'ok', output: {} }],
      },
    },
  ],
};

const messageSchema = {
  type: 'object' as const,
  // The source compiler treats a literal as a finite producer.  Source schemas
  // are intentionally invariant here, so make this fixture's input contract
  // exactly describe the literal it supplies.
  properties: { message: { type: 'string' as const, enum: ['hello'] } },
  required: ['message'],
  additionalProperties: false as const,
};

const scriptPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-script',
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
        entry: 'echo',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'script',
            id: 'echo',
            requirementKey: 'echo',
            script: { id: 'script:system/echo', version: 1 },
            input: { message: { kind: 'literal', value: 'hello' } },
            inputSchema: messageSchema,
            outputSchema: messageSchema,
            routes: { succeeded: 'done', failed: 'done', cancelled: 'done' },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const signalPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-signal',
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
        entry: 'pause',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'wait',
            id: 'pause',
            wait: { kind: 'signal', signal: 'continue', payloadSchema: null },
            routes: { completed: 'done', cancelled: 'done' },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const gatePipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-gate',
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
        entry: 'approve',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'humanGate',
            id: 'approve',
            subject: 'Approve the run',
            answers: ['approved'],
            authorizationRequirements: ['reviewer'],
            payloadSchema: null,
            deadline: null,
            routes: { answers: [{ answer: 'approved', target: 'done' }], cancelled: 'done' },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const parallelSignalPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-parallel-signals',
  entryModule: 'main',
  maximumTotalActivities: 2,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'parallel',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'parallel',
            id: 'parallel',
            policy: { kind: 'all' },
            remaining: 'drain',
            routes: {
              completed: 'done',
              impossible: 'done',
              failed: 'done',
              cancelled: 'done',
            },
            branches: [
              {
                key: 'left',
                input: {},
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
                region: {
                  key: 'left-region',
                  inputSchema: emptySchema,
                  entry: 'left-wait',
                  outputSchema: emptySchema,
                  exits: [{ outcome: 'ok', outputSchema: emptySchema }],
                  nodes: [
                    {
                      kind: 'wait',
                      id: 'left-wait',
                      wait: { kind: 'signal', signal: 'left', payloadSchema: null },
                      routes: { completed: 'left-done', cancelled: 'left-done' },
                    },
                    { kind: 'end', id: 'left-done', outcome: 'ok', output: {} },
                  ],
                },
              },
              {
                key: 'right',
                input: {},
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
                region: {
                  key: 'right-region',
                  inputSchema: emptySchema,
                  entry: 'right-wait',
                  outputSchema: emptySchema,
                  exits: [{ outcome: 'ok', outputSchema: emptySchema }],
                  nodes: [
                    {
                      kind: 'wait',
                      id: 'right-wait',
                      wait: { kind: 'signal', signal: 'right', payloadSchema: null },
                      routes: { completed: 'right-done', cancelled: 'right-done' },
                    },
                    { kind: 'end', id: 'right-done', outcome: 'ok', output: {} },
                  ],
                },
              },
            ],
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('raw pipeline kernel host', () => {
  it('compiles once and runs an admitted raw terminal pipeline through the DBOS kernel workflow', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('A terminal pipeline does not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('A terminal pipeline does not acquire a credential.');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-terminal-${randomUUID()}`;

    await expect(
      manager.createRun({
        runId,
        pipeline: terminalPipeline,
        profile: {
          schemaVersion: 'run-profile/v1',
          selections: {},
          bindings: { agents: {}, scripts: {} },
        },
        input: {},
      }),
    ).resolves.toStrictEqual({ runId });

    await expect
      .poll(() => manager?.getRun(runId))
      .toMatchObject({
        runId,
        status: 'succeeded',
        terminal: { kind: 'succeeded', outcome: 'ok', output: {} },
      });
    const snapshot = await manager.getRun(runId);
    const details = await manager.getRunDetails(runId);
    expect(snapshot).not.toBeUndefined();
    expect(details).not.toBeUndefined();
    expect(Check(RunSnapshotSchema, snapshot)).toBe(true);
    expect(Check(RunDetailsSchema, details)).toBe(true);
    const events = await manager.getRunEvents(runId);
    expect(events.items.map(({ payload }) => payload.type)).toContain('run.admitted');
    expect(events.items.map(({ payload }) => payload.type)).toContain('run.terminal');
  });

  it('atomically claims a run ID with the admitted payload rather than accepting a concurrent mismatch', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('A terminal pipeline does not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('A terminal pipeline does not acquire a credential.');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-atomic-claim-${randomUUID()}`;
    const profile = {
      schemaVersion: 'run-profile/v1' as const,
      selections: {},
      bindings: { agents: {}, scripts: {} },
    };
    const results = await Promise.allSettled([
      manager.createRun({ runId, pipeline: terminalPipeline, profile, input: {} }),
      manager.createRun({
        runId,
        pipeline: { ...terminalPipeline, key: 'rn1-terminal-concurrent-mismatch' },
        profile,
        input: {},
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<{ readonly runId: string }> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toStrictEqual({ runId });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'run_id_conflict' });
  });

  it('does not create a DBOS run or call a host resolver when raw admission rejects before commit', async () => {
    const scenario = recoveryScenario('D1');
    const calls = { resources: 0, workspaces: 0, credentials: 0 };
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: {
          inspect: async () => {
            calls.resources += 1;
            return undefined;
          },
        },
        workspaces: {
          inspect: async () => {
            calls.workspaces += 1;
            return undefined;
          },
          acquire: async () => {
            calls.workspaces += 1;
            throw new Error('Admission must not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => {
            calls.credentials += 1;
            return undefined;
          },
          acquire: async () => {
            calls.credentials += 1;
            throw new Error('Admission must not acquire a credential.');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-admission-rejected-${randomUUID()}`;

    await expect(
      manager.createRun({
        runId,
        pipeline: scriptPipeline,
        profile: {
          schemaVersion: 'run-profile/v1',
          selections: {},
          bindings: { agents: {}, scripts: {} },
        },
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'run_requirement_unresolved' });

    const rootStatus = await DBOS.getWorkflowStatus(`revo-run:${runId}`);
    const eventLog =
      rootStatus === null
        ? []
        : (await manager.getRunEvents(runId)).items.map(({ payload }) => payload);
    assertRecoveryObservation(scenario, {
      state: rootStatus === null ? 'absent' : 'present',
      status: rootStatus === null ? 'absent' : rootStatus.status,
      events: {
        script: eventLog.filter(({ type }) => type === 'script.event').length,
        kernel: eventLog.filter(({ type }) => type === 'run.terminal').length,
      },
      calls: {
        execute: eventLog.filter(({ type }) => type === 'activity.attempt_started').length,
        reconcile: eventLog.filter(({ type }) => type === 'activity.recovery_required').length,
        cancel: eventLog.filter(({ type }) => type === 'run.cancellation_acknowledged').length,
      },
      prohibited: {
        recoveryCreatesRun: rootStatus !== null,
        newAttempt: calls.resources + calls.workspaces + calls.credentials > 0,
      },
    });
    expect(calls).toStrictEqual({ resources: 0, workspaces: 0, credentials: 0 });
  });

  it('hosts one SC1 script attempt and relays only its sealed/live events through the root', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('System echo does not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('System echo does not acquire a credential.');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-script-${randomUUID()}`;

    await manager.createRun({
      runId,
      pipeline: scriptPipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: {
          agents: {},
          scripts: { echo: { resources: {}, credentials: {} } },
        },
      },
      input: {},
    });

    await expect.poll(() => manager?.getRun(runId)).toMatchObject({ status: 'succeeded' });
    const events = await manager.getRunEvents(runId);
    expect(
      events.items
        .filter(({ payload }) => payload.type === 'script.event')
        .map(({ payload }) => (payload.type === 'script.event' ? payload.event.name : undefined)),
    ).toStrictEqual(['revo.script.started', 'revo.script.succeeded']);
    const details = await manager.getRunDetails(runId);
    const operation = details?.operations.find(({ kind }) => kind === 'script');
    expect(operation).toBeDefined();
    await expect(
      DBOS.getWorkflowStatus(`revo-run.operation:${operation?.operationId}`),
    ).resolves.toMatchObject({ workflowName: 'revo-run.operation-host/v1' });
  });

  it('opens a stable signal wait, exposes its generated wait ID, and applies one signal through the kernel', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('A signal wait does not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('A signal wait does not acquire a credential.');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-signal-${randomUUID()}`;
    await manager.createRun({
      runId,
      pipeline: signalPipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: {} },
      },
      input: {},
    });

    await expect
      .poll(() => manager?.getRunDetails(runId))
      .toMatchObject({
        status: 'running',
        waits: [expect.objectContaining({ kind: 'signal', signal: 'continue', status: 'pending' })],
      });
    const details = await manager.getRunDetails(runId);
    if (details === undefined) {
      throw new Error('Expected the admitted run details.');
    }
    const wait = details.waits[0];
    if (wait === undefined) {
      throw new Error('Expected one pending signal wait.');
    }
    const activeEvents = await manager.getRunEvents(runId);
    expect(activeEvents.hasMore).toBe(false);
    expect(activeEvents.items.some((event) => event.payload.type === 'wait.opened')).toBe(true);
    await manager.sendSignal({ runId, waitId: wait.waitId, signal: 'continue', actorId: 'user-1' });

    await expect
      .poll(() => manager?.getRun(runId))
      .toMatchObject({
        status: 'succeeded',
        terminal: { kind: 'succeeded', outcome: 'ok', output: {} },
      });
  });

  it('dispatches a full kernel command batch as concurrent child operations before it receives either event', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Parallel signal waits do not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Parallel signal waits do not acquire a credential.');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-parallel-signals-${randomUUID()}`;
    await manager.createRun({
      runId,
      pipeline: parallelSignalPipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: {} },
      },
      input: {},
    });

    await expect
      .poll(async () => {
        const details = await manager?.getRunDetails(runId);
        return details?.waits
          .filter((wait) => wait.status === 'pending')
          .map((wait) => wait.signal)
          .toSorted();
      })
      .toStrictEqual(['left', 'right']);
    const details = await manager.getRunDetails(runId);
    if (details === undefined || details.waits.length !== 2) {
      throw new Error('Expected both sibling waits to be durable before either resolves.');
    }
    if (manager === undefined) {
      throw new Error('Expected the test manager.');
    }
    const activeManager = manager;
    await Promise.all(
      details.waits.map((wait) =>
        activeManager.sendSignal({
          runId,
          waitId: wait.waitId,
          signal: wait.signal ?? '',
          actorId: 'user-1',
        }),
      ),
    );
    await expect
      .poll(() => manager?.getRun(runId), { timeout: 10_000, interval: 100 })
      .toMatchObject({ status: 'succeeded' });
  });

  it('accepts one cancellation while a signal wait is pending and lets the kernel seal the cancelled terminal', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-cancel-signal-${randomUUID()}`;
    await manager.createRun({
      runId,
      pipeline: signalPipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: {} },
      },
      input: {},
    });

    await expect
      .poll(() => manager?.getRunDetails(runId))
      .toMatchObject({
        waits: [expect.objectContaining({ kind: 'signal', status: 'pending' })],
      });
    await expect(manager.cancelRun({ runId, actorId: 'operator-1' })).resolves.toBeUndefined();
    await expect
      .poll(() => manager?.getRun(runId), { timeout: 10_000, interval: 100 })
      .toMatchObject({
        status: 'cancelled',
        terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
      });
    await expect(manager.cancelRun({ runId, actorId: 'operator-2' })).resolves.toBeUndefined();
    const events = await manager.getRunEvents(runId);
    expect(
      events.items.filter(({ payload }) => payload.type === 'run.cancellation_requested'),
    ).toHaveLength(1);
    expect(
      events.items.some(
        (event) =>
          event.payload.type === 'wait.resolved' && event.payload.wait.status === 'cancelled',
      ),
    ).toBe(true);
  });

  it('opens a stable human gate and applies the accepted answer through the kernel', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-gate-${randomUUID()}`;
    await manager.createRun({
      runId,
      pipeline: gatePipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: {} },
      },
      input: {},
    });

    await expect
      .poll(() => manager?.getRunDetails(runId))
      .toMatchObject({
        status: 'running',
        gates: [expect.objectContaining({ subject: 'Approve the run', status: 'pending' })],
      });
    const details = await manager.getRunDetails(runId);
    if (details === undefined || details.gates[0] === undefined) {
      throw new Error('Expected one pending human gate.');
    }
    await expect(
      manager.answerGate({
        runId,
        gateId: details.gates[0].gateId,
        answer: 'approved',
        actorId: 'untrusted-1',
      }),
    ).rejects.toMatchObject({ code: 'run_gate_unauthorized' });
    await expect(manager.getRunDetails(runId)).resolves.toMatchObject({
      gates: [expect.objectContaining({ status: 'pending' })],
    });
    await manager.answerGate({
      runId,
      gateId: details.gates[0].gateId,
      answer: 'approved',
      actorId: 'reviewer-1',
      actorGroups: ['reviewer'],
    });

    await expect
      .poll(() => manager?.getRun(runId))
      .toMatchObject({
        status: 'succeeded',
        terminal: { kind: 'succeeded', outcome: 'ok', output: {} },
      });
  });

  it('cancels a pending human gate through the kernel instead of treating request acceptance as terminal', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-cancel-gate-${randomUUID()}`;
    await manager.createRun({
      runId,
      pipeline: gatePipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: {} },
      },
      input: {},
    });
    await expect
      .poll(() => manager?.getRunDetails(runId))
      .toMatchObject({
        gates: [expect.objectContaining({ status: 'pending' })],
      });
    await manager.cancelRun({ runId, actorId: 'operator-1' });
    await expect
      .poll(() => manager?.getRun(runId), { timeout: 10_000, interval: 100 })
      .toMatchObject({
        status: 'cancelled',
        terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
      });
    await expect(manager.getRunDetails(runId)).resolves.toMatchObject({
      gates: [expect.objectContaining({ status: 'cancelled', resolution: { kind: 'cancelled' } })],
    });
  });

  it('resolves a durable gate deadline through the pipeline kernel without a consumer answer', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('unused');
          },
        },
      },
    });
    await manager.start();
    const module = gatePipeline.modules[0];
    const gate = module?.region.nodes[0];
    if (module === undefined || gate?.kind !== 'humanGate') {
      throw new Error('Expected the human-gate fixture.');
    }
    const pipeline: PipelineSourcePackage = {
      ...gatePipeline,
      key: 'rn1-gate-deadline',
      modules: [
        {
          ...module,
          region: {
            ...module.region,
            nodes: [
              { ...gate, deadline: { afterMs: 25, target: 'done' } },
              ...module.region.nodes.slice(1),
            ],
          },
        },
      ],
    };
    const runId = `rn1-gate-deadline-${randomUUID()}`;
    await manager.createRun({
      runId,
      pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: {} },
      },
      input: {},
    });
    await expect
      .poll(() => manager?.getRun(runId), { timeout: 10_000, interval: 25 })
      .toMatchObject({ status: 'succeeded' });
    await expect(manager.getRunDetails(runId)).resolves.toMatchObject({
      gates: [expect.objectContaining({ status: 'deadline', resolution: { kind: 'deadline' } })],
      operations: [expect.objectContaining({ kind: 'humanGate', status: 'succeeded' })],
    });
  });
});
