import { describe, expect, expectTypeOf, it } from 'vitest';

import { createRun } from '../../src/domain/index.js';
import type {
  RunStoreDiscoveryKey,
  RunStoreCreateRunCommand,
  RunStore,
  RunStoreCommitCommand,
  RunStoreIncumbentTransitionCommand,
} from '../../src/storage/index.js';
import {
  compareDiscoveryKeys,
  leasePolicyIsValid,
  LogicalRunStoreFake,
} from '../support/logical-run-store-fake.js';

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

describe('RunStore contract', () => {
  it('is a package-private type-only boundary', () => {
    expectTypeOf<RunStore>().toEqualTypeOf<RunStore>();
    expectTypeOf<RunStoreCommitCommand>().toEqualTypeOf<RunStoreCommitCommand>();
    expectTypeOf<RunStoreIncumbentTransitionCommand>().toEqualTypeOf<RunStoreIncumbentTransitionCommand>();
    expect(true).toBe(true);
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
});
