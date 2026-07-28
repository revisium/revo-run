import { describe, expect, expectTypeOf, it } from 'vitest';

import { createRun } from '../../src/domain/index.js';
import type {
  RunStoreDiscoveryKey,
  RunStoreCreateRunCommand,
  RunStore,
  RunStoreCommitCommand,
  RunStoreIncumbentTransitionCommand,
  RunStoreProgressionTransitionCommand,
} from '../../src/storage/index.js';
import {
  compareDiscoveryKeys,
  leasePolicyIsValid,
  LogicalRunStoreFake,
} from '../support/logical-run-store-fake.js';
import { attemptFixture, nodeFixture, runFixture } from '../support/store-fixtures.js';

const createCommand = (
  runId: string,
  request: { readonly marker: string },
): RunStoreCreateRunCommand => ({
  kind: 'create_run',
  run: createRun({
    cancellationRequestedAt: null,
    createdAt: 1_000,
    id: runId,
    input: null,
    planPin: { digest: 'digest', id: 'plan', revision: '1' },
    progression: {
      candidateVerdicts: [],
      commandReceipts: [],
      gateResolutions: [],
      nodes: [],
      occurrenceKey: 'occurrence-1',
      phase: 'uninitialized',
      schemaVersion: 1,
      terminal: null,
      values: [],
    },
    revision: 0,
    status: 'running',
    terminalAt: null,
    terminalFault: null,
    updatedAt: 1_000,
  }),
  nodes: [],
  outputs: [],
  eventIntents: [],
  expected: {
    absentRunId: runId,
    absentNodes: [],
    absentOutputIds: [],
  },
  idempotency: {
    identity: {
      operation: 'start_run',
      runId: null,
      subjectId: null,
      key: 'request-1',
    },
    request,
    result: { runId },
  },
});

const progressionCreateCommand = (request: {
  readonly marker: string;
}): RunStoreProgressionTransitionCommand => ({
  expected: {
    absentNodes: [],
    absentOutputIds: [],
    absentRunId: 'progression-run',
    kind: 'create',
  },
  idempotency: {
    identity: {
      key: 'progression-request-1',
      operation: 'initialize_progression',
      runId: 'progression-run',
      subjectId: 'progression-run',
    },
    request,
    result: {
      application: 'applied',
      occurrenceKey: 'occurrence-1',
      operation: 'initialize',
      outcome: { kind: 'waiting' },
      schemaVersion: 1,
    },
  },
  kind: 'apply_progression_transition',
  operation: 'initialize',
  transition: {
    attempts: [],
    changed: true,
    eventIntents: [],
    nodes: [],
    outputs: [],
    run: createRun({
      cancellationRequestedAt: null,
      createdAt: 2_000,
      id: 'progression-run',
      input: null,
      planPin: { digest: 'digest', id: 'plan', revision: '1' },
      progression: {
        candidateVerdicts: [],
        commandReceipts: [
          {
            hostAttachment: { kind: 'none' },
            identity: {
              commandKey: 'initialize-command',
              nodeKey: null,
              operation: 'initialize',
            },
            result: {
              application: 'applied',
              occurrenceKey: 'occurrence-1',
              operation: 'initialize',
              outcome: { kind: 'waiting' },
              schemaVersion: 1,
            },
            semanticRequest: {
              kind: 'initialize',
              occurrenceKey: 'occurrence-1',
              values: [],
            },
          },
        ],
        gateResolutions: [],
        nodes: [{ nodeKey: 'task', state: 'enabled' }],
        occurrenceKey: 'occurrence-1',
        phase: 'active',
        schemaVersion: 1,
        terminal: null,
        values: [],
      },
      revision: 0,
      status: 'running',
      terminalAt: null,
      terminalFault: null,
      updatedAt: 2_000,
    }),
  },
  trigger: { kind: 'run', runId: 'progression-run' },
});

describe('RunStore contract', () => {
  it('is a package-private type-only boundary', () => {
    expectTypeOf<RunStore>().toHaveProperty('transaction');
    expectTypeOf<RunStore>().not.toHaveProperty('claimAttempt');
    expectTypeOf<RunStoreCommitCommand>().toHaveProperty('kind');
    expectTypeOf<RunStoreIncumbentTransitionCommand>().toHaveProperty('operation');
    expectTypeOf<RunStoreIncumbentTransitionCommand>().not.toHaveProperty('execute');
  });

  it('uses store transaction time and terminalizes after a commit result', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const result = await store.transaction(async (transaction) => {
      const committed = await transaction.commit(createCommand('run-1', { marker: 'a' }));
      const afterCommit = await transaction.getRun('run-1');
      return { committed, afterCommit };
    });

    expect(result.committed).toMatchObject({
      kind: 'committed',
      transactionNow: 1_000,
    });
    expect(result.afterCommit).toMatchObject({
      kind: 'invalid_input',
      fault: { code: 'INVALID_INPUT' },
    });
    await expect(store.getRun('run-1')).resolves.toMatchObject({
      kind: 'found',
      value: { id: 'run-1', createdAt: 1_000 },
    });
  });

  it('invalidates a captured transaction after callback completion and after conflict', async () => {
    const store = new LogicalRunStoreFake(1_000);
    let captured: Parameters<Parameters<RunStore['transaction']>[0]>[0] | undefined;
    await store.transaction(async (transaction) => {
      captured = transaction;
      return transaction.getRun('missing');
    });
    await expect(captured?.getRun('missing')).resolves.toMatchObject({
      kind: 'invalid_input',
    });

    await store.transaction(async (transaction) =>
      transaction.commit(createCommand('run-1', { marker: 'a' })),
    );
    await store.transaction(async (transaction) => {
      captured = transaction;
      return transaction.commit(createCommand('run-1', { marker: 'b' }));
    });
    await expect(captured?.getRun('run-1')).resolves.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('replays semantic JSON before stale Run CAS and conflicts on a changed request', async () => {
    const store = new LogicalRunStoreFake(1_000);
    await store.transaction(async (transaction) =>
      transaction.commit(createCommand('run-1', { marker: 'a' })),
    );

    const replay = await store.transaction(async (transaction) =>
      transaction.commit(createCommand('run-1', { marker: 'a' })),
    );
    const changed = await store.transaction(async (transaction) =>
      transaction.commit(createCommand('run-1', { marker: 'b' })),
    );

    expect(replay).toMatchObject({ kind: 'replayed' });
    expect(changed).toMatchObject({
      kind: 'conflict',
      conflict: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('atomically creates and replays one initialized progression occurrence', async () => {
    const store = new LogicalRunStoreFake(2_000);
    const command = progressionCreateCommand({ marker: 'stable' });

    await expect(
      store.transaction((transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      store.transaction((transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    await expect(
      store.transaction((transaction) =>
        transaction.commit(progressionCreateCommand({ marker: 'changed' })),
      ),
    ).resolves.toMatchObject({
      conflict: { code: 'IDEMPOTENCY_CONFLICT' },
      kind: 'conflict',
    });
    await expect(store.getRun('progression-run')).resolves.toMatchObject({
      kind: 'found',
      value: {
        progression: { occurrenceKey: 'occurrence-1', phase: 'active' },
      },
    });
  });

  it('rejects a progression idempotency receipt that is not bound to the transition', async () => {
    const store = new LogicalRunStoreFake(2_000);
    const command = progressionCreateCommand({ marker: 'misbound' });

    await expect(
      store.transaction((transaction) =>
        transaction.commit({
          ...command,
          idempotency: {
            ...command.idempotency,
            result: {
              ...command.idempotency.result,
              operation: 'task_outcome',
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
    await expect(store.getRun('progression-run')).resolves.toEqual({ kind: 'not_found' });
  });

  it('rejects an operation-incompatible progression trigger without writing', async () => {
    const store = new LogicalRunStoreFake(2_000);
    const command = progressionCreateCommand({ marker: 'trigger' });

    await expect(
      store.transaction((transaction) =>
        transaction.commit({
          ...command,
          trigger: {
            activationId: 'activation-1',
            kind: 'activation',
            nodeInstanceId: 'node-1',
            runId: 'progression-run',
          },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
    await expect(store.getRun('progression-run')).resolves.toEqual({ kind: 'not_found' });
  });

  it.each(['run', 'nodes', 'outputs', 'events', 'idempotency'] as const)(
    'rolls back progression initialization after an injected %s-stage failure',
    async (stage) => {
      const store = new LogicalRunStoreFake(2_000);
      const command = progressionCreateCommand({ marker: stage });
      store.failAfterNextStage(stage);

      await expect(store.transaction((transaction) => transaction.commit(command))).rejects.toThrow(
        `Injected logical provider failure after ${stage}.`,
      );
      await expect(store.getRun('progression-run')).resolves.toEqual({ kind: 'not_found' });
      await expect(
        store.transaction((transaction) => transaction.commit(command)),
      ).resolves.toMatchObject({ kind: 'committed' });
    },
  );

  it('rolls back staged state when the callback rejects', async () => {
    const store = new LogicalRunStoreFake(1_000);

    await expect(
      store.transaction(async (transaction) => {
        await transaction.commit(createCommand('run-1', { marker: 'a' }));
        throw new Error('provider failed');
      }),
    ).rejects.toThrow('provider failed');

    await expect(store.getRun('run-1')).resolves.toEqual({ kind: 'not_found' });
  });

  it('invokes a rejected callback exactly once and preserves provider failure', async () => {
    const store = new LogicalRunStoreFake(1_000);
    let invocations = 0;

    await expect(
      store.transaction(async () => {
        invocations += 1;
        throw new Error('provider failed');
      }),
    ).rejects.toThrow('provider failed');

    expect(invocations).toBe(1);
  });

  it('rejects caller-shaped durable timestamps without writing', async () => {
    const store = new LogicalRunStoreFake(1_001);
    const result = await store.transaction(async (transaction) =>
      transaction.commit(createCommand('run-1', { marker: 'a' })),
    );

    expect(result).toMatchObject({
      kind: 'invalid_input',
      fault: { code: 'INVALID_INPUT' },
    });
    await expect(store.getRun('run-1')).resolves.toEqual({ kind: 'not_found' });
  });

  it('compares idempotency requests semantically rather than by object order', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const original = createCommand('run-1', { marker: 'a' });
    await store.transaction(async (transaction) => transaction.commit(original));
    const reordered: RunStoreCreateRunCommand = {
      ...original,
      idempotency: {
        ...original.idempotency,
        request: { second: [1, true], first: 'value' },
      },
    };
    const firstOrder: RunStoreCreateRunCommand = {
      ...original,
      idempotency: {
        ...original.idempotency,
        request: { first: 'value', second: [1, true] },
      },
    };
    const secondStore = new LogicalRunStoreFake(1_000);
    await secondStore.transaction(async (transaction) => transaction.commit(firstOrder));

    await expect(
      secondStore.transaction(async (transaction) => transaction.commit(reordered)),
    ).resolves.toMatchObject({ kind: 'replayed' });
  });

  it.each([
    [999, 100, false],
    [1_000, 99, false],
    [1_000, 100, true],
    [86_400_000, 86_399_999, true],
    [86_400_001, 100, false],
    [1_000, 1_000, false],
  ])(
    'validates lease duration %i and heartbeat %i at exact policy bounds',
    (leaseDurationMs, heartbeatIntervalMs, expected) => {
      expect(leasePolicyIsValid(0, leaseDurationMs, heartbeatIntervalMs)).toBe(expected);
    },
  );

  it('orders discovery by time, kind rank, UTF-8 ids, and null-first identities', () => {
    const base: RunStoreDiscoveryKey = {
      eligibleAt: 10,
      kind: 'expired_attempt',
      runId: 'run',
      nodeInstanceId: null,
      attemptId: null,
    };
    const keys: RunStoreDiscoveryKey[] = [
      { ...base, kind: 'renewable_attempt' },
      { ...base, nodeInstanceId: 'node' },
      base,
      { ...base, kind: 'handoff_attempt' },
      { ...base, eligibleAt: 9 },
    ];

    expect(keys.sort(compareDiscoveryKeys)).toEqual([
      { ...base, eligibleAt: 9 },
      { ...base, kind: 'handoff_attempt' },
      base,
      { ...base, nodeInstanceId: 'node' },
      { ...base, kind: 'renewable_attempt' },
    ]);
  });

  it('discovers progression-closed active authority only as a retiring Attempt', async () => {
    const store = new LogicalRunStoreFake(2_000);
    store.seed({
      attempts: [
        attemptFixture({
          progressionClosedAt: 1_900,
          status: 'start_committed',
          updatedAt: 1_900,
        }),
      ],
      nodes: [
        nodeFixture({
          activeAttemptId: 'attempt-1',
          status: 'retiring',
          updatedAt: 1_900,
        }),
      ],
      runs: [
        runFixture({
          progression: {
            candidateVerdicts: [],
            commandReceipts: [],
            gateResolutions: [],
            nodes: [],
            occurrenceKey: 'occurrence-1',
            phase: 'terminal',
            schemaVersion: 1,
            terminal: { nodeKey: 'terminal', outcome: 'success' },
            values: [],
          },
          revision: 1,
          status: 'succeeded',
          terminalAt: 1_900,
          updatedAt: 1_900,
        }),
      ],
    });

    await expect(
      store.discover({
        kinds: ['retiring_attempt'],
        limit: 10,
        renewal: null,
        scan: { kind: 'start' },
      }),
    ).resolves.toMatchObject({
      kind: 'page',
      page: {
        items: [
          {
            eligibleAt: 1_900,
            kind: 'retiring_attempt',
            observedAttempt: { attemptId: 'attempt-1' },
            observedNode: { nodeInstanceId: 'node-1' },
            observedRun: { runId: 'run-1' },
          },
        ],
      },
    });
  });
});
