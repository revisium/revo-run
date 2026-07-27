import { describe, expect, expectTypeOf, it } from 'vitest';

import { createRunLifecycle } from '../../src/lifecycle/construction.js';
import type { LifecycleObservedNode } from '../../src/lifecycle/index.js';
import type { RunStore, RunStoreObservedNode } from '../../src/storage/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  attemptFixture,
  executingNodeFixture,
  nodeFixture,
  runFixture,
} from '../support/store-fixtures.js';

const discover = (
  store: RunStore,
  kinds: readonly ['claimable_node'] | readonly ['expired_attempt'],
) =>
  createRunLifecycle({
    executors: {
      resolveExact: async () => ({
        fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'unused' },
        kind: 'unavailable',
      }),
    },
    store,
  }).discover({
    kinds,
    limit: 10,
    renewal: null,
    scan: { kind: 'start' },
  });

const invalidDiscovery = {
  fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
  kind: 'fault',
};

const storeReturning = (
  base: LogicalRunStoreFake,
  result: Awaited<ReturnType<RunStore['discover']>>,
): RunStore => ({
  discover: async () => result,
  getRun: (runId) => base.getRun(runId),
  listRuns: (query) => base.listRuns(query),
  readEvents: (query) => base.readEvents(query),
  transaction: (callback) => base.transaction(callback),
});

const nodeBearingResult = async (nodeKey = 'node') => {
  const base = new LogicalRunStoreFake(1_500);
  base.seed({ nodes: [nodeFixture({ nodeKey })], runs: [runFixture()] });
  const result = await base.discover({
    kinds: ['claimable_node'],
    limit: 1,
    renewal: null,
    scan: { kind: 'start' },
  });
  const candidate = result.kind === 'page' ? result.page.items[0] : undefined;
  if (candidate === undefined || candidate.observedNode === null) {
    throw new Error('Expected one node-bearing discovery result.');
  }
  return { base, candidate, node: candidate.observedNode, result };
};

describe('discovery node identity', () => {
  it('requires the logical node key on both Store and lifecycle observations', () => {
    expectTypeOf<keyof RunStoreObservedNode>().toEqualTypeOf<
      'activeAttemptId' | 'nodeInstanceId' | 'nodeKey' | 'nodeRevision'
    >();
    expectTypeOf<keyof LifecycleObservedNode>().toEqualTypeOf<
      'activeAttemptId' | 'nodeInstanceId' | 'nodeKey' | 'nodeRevision'
    >();
  });

  it('projects and freezes nodeKey for every node-bearing candidate', async () => {
    const store = new LogicalRunStoreFake(3_000);
    const handoffAttempt = attemptFixture({
      id: 'attempt-handoff',
      leaseExpiresAt: 4_000,
      nodeInstanceId: 'node-handoff',
    });
    store.seed({
      attempts: [
        attemptFixture({ leaseExpiresAt: 2_999 }),
        handoffAttempt,
        attemptFixture({
          id: 'attempt-renewable',
          leaseExpiresAt: 4_000,
          managerIncarnationId: 'manager-renewal',
          nodeInstanceId: 'node-renewable',
        }),
      ],
      handoffs: [
        {
          consumption: null,
          handoff: {
            activationId: 'activation-handoff',
            createdAt: 2_000,
            expectedAttemptRevision: handoffAttempt.revision,
            id: 'handoff-1',
            incumbentManagerIncarnationId: handoffAttempt.managerIncarnationId,
            key: {
              attemptId: handoffAttempt.id,
              incumbentFencingToken: handoffAttempt.fencingToken,
            },
            nodeInstanceId: 'node-handoff',
            reason: 'manager_shutdown',
            runId: handoffAttempt.runId,
          },
        },
      ],
      nodes: [
        nodeFixture({ id: 'ready-activation', nodeKey: 'shared-node' }),
        executingNodeFixture('executing', { nodeKey: 'executing-node' }),
        executingNodeFixture('executing', {
          activationId: 'activation-handoff',
          activeAttemptId: 'attempt-handoff',
          id: 'node-handoff',
          nodeKey: 'handoff-node',
        }),
        executingNodeFixture('executing', {
          activationId: 'activation-renewable',
          activeAttemptId: 'attempt-renewable',
          id: 'node-renewable',
          nodeKey: 'renewable-node',
        }),
      ],
      runs: [runFixture()],
    });

    const claimable = await discover(store, ['claimable_node']);
    const attempts = await createRunLifecycle({
      executors: {
        resolveExact: async () => ({
          fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'unused' },
          kind: 'unavailable',
        }),
      },
      store,
    }).discover({
      kinds: ['handoff_attempt', 'expired_attempt', 'renewable_attempt'],
      limit: 10,
      renewal: {
        leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
        managerIncarnationId: 'manager-renewal',
      },
      scan: { kind: 'start' },
    });

    expect(claimable).toMatchObject({
      kind: 'page',
      page: { items: [{ node: { nodeInstanceId: 'ready-activation', nodeKey: 'shared-node' } }] },
    });
    expect(attempts).toMatchObject({ kind: 'page' });
    if (attempts.kind !== 'page') return;
    expect(
      attempts.page.items.map((item) => ({
        kind: item.kind,
        nodeKey: item.node?.nodeKey,
      })),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'expired_attempt', nodeKey: 'executing-node' },
        { kind: 'handoff_attempt', nodeKey: 'handoff-node' },
        { kind: 'renewable_attempt', nodeKey: 'renewable-node' },
      ]),
    );
    if (claimable.kind !== 'page' || claimable.page.items[0]?.node === null) return;
    expect(Object.isFrozen(claimable.page.items[0]?.node)).toBe(true);
    for (const item of attempts.page.items) {
      expect(Object.isFrozen(item.node)).toBe(true);
    }
  });

  it('keeps repeated activations distinct while preserving their shared logical key', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      nodes: [
        nodeFixture({ activationId: 'activation-a', id: 'node-a', nodeKey: 'repeat' }),
        nodeFixture({ activationId: 'activation-b', id: 'node-b', nodeKey: 'repeat' }),
      ],
      runs: [runFixture()],
    });

    const result = await discover(store, ['claimable_node']);

    expect(result).toMatchObject({
      kind: 'page',
      page: {
        items: [
          { node: { nodeInstanceId: 'node-a', nodeKey: 'repeat' } },
          { node: { nodeInstanceId: 'node-b', nodeKey: 'repeat' } },
        ],
      },
    });
  });

  it('keeps a shared nodeKey contextual to each exact Run plan pin', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      nodes: [
        nodeFixture({ id: 'node-plan-a', nodeKey: 'shared', runId: 'run-plan-a' }),
        nodeFixture({ id: 'node-plan-b', nodeKey: 'shared', runId: 'run-plan-b' }),
      ],
      runs: [
        runFixture({
          id: 'run-plan-a',
          planPin: { digest: 'digest-a', id: 'plan-a', revision: '1' },
        }),
        runFixture({
          id: 'run-plan-b',
          planPin: { digest: 'digest-b', id: 'plan-b', revision: '1' },
        }),
      ],
    });

    const result = await discover(store, ['claimable_node']);

    expect(result).toMatchObject({
      kind: 'page',
      page: {
        items: [
          { node: { nodeKey: 'shared' }, run: { planPin: { id: 'plan-a' } } },
          { node: { nodeKey: 'shared' }, run: { planPin: { id: 'plan-b' } } },
        ],
      },
    });
  });

  it.each([
    ['single-byte', 'n'.repeat(256)],
    ['multibyte', 'é'.repeat(128)],
  ])('accepts the exact 256-byte %s nodeKey boundary', async (_label, nodeKey) => {
    const { base } = await nodeBearingResult(nodeKey);

    await expect(discover(base, ['claimable_node'])).resolves.toMatchObject({
      kind: 'page',
      page: { items: [{ node: { nodeKey } }] },
    });
  });

  it.each(['', 'x'.repeat(257), 'é'.repeat(129), 'control\u0001', '\ud800'])(
    'rejects an invalid discovered nodeKey without exposing its value',
    async (nodeKey) => {
      const { base, node, result } = await nodeBearingResult();
      Reflect.set(node, 'nodeKey', nodeKey);

      await expect(discover(storeReturning(base, result), ['claimable_node'])).resolves.toEqual(
        invalidDiscovery,
      );
    },
  );

  it('reads nodeKey through an own data descriptor without invoking an accessor', async () => {
    const { base, node, result } = await nodeBearingResult();
    let getterCalls = 0;
    Object.defineProperty(node, 'nodeKey', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'node';
      },
    });

    await expect(discover(storeReturning(base, result), ['claimable_node'])).resolves.toEqual(
      invalidDiscovery,
    );
    expect(getterCalls).toBe(0);
  });

  it.each(['missing nodeKey', 'extra own key'] as const)(
    'maps an observed node with %s to fixed invalid input',
    async (variant) => {
      const { base, node, result } = await nodeBearingResult();
      if (variant === 'missing nodeKey') {
        Reflect.deleteProperty(node, 'nodeKey');
      } else {
        Reflect.set(node, 'extra', true);
      }

      await expect(discover(storeReturning(base, result), ['claimable_node'])).resolves.toEqual(
        invalidDiscovery,
      );
    },
  );

  it('propagates an arbitrary provider Proxy failure', async () => {
    const { base, candidate, node, result } = await nodeBearingResult();
    const proxy = new Proxy(node, {
      ownKeys: () => {
        throw new Error('provider detail');
      },
    });
    Reflect.set(candidate, 'observedNode', proxy);

    await expect(discover(storeReturning(base, result), ['claimable_node'])).rejects.toThrow(
      'provider detail',
    );
  });

  it('keeps run-only discovery candidates node-free', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      runs: [
        runFixture({
          cancellationRequestedAt: 1_400,
          id: 'cancelling',
          status: 'cancelling',
          updatedAt: 1_400,
        }),
      ],
    });

    const result = await createRunLifecycle({
      executors: {
        resolveExact: async () => ({
          fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'unused' },
          kind: 'unavailable',
        }),
      },
      store,
    }).discover({
      kinds: ['cancellation_run'],
      limit: 10,
      renewal: null,
      scan: { kind: 'start' },
    });

    expect(result).toMatchObject({ kind: 'page', page: { items: [{ node: null }] } });
  });
});
