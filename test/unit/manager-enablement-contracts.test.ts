import { describe, expect, expectTypeOf, it } from 'vitest';

import { createRunLifecycle } from '../../src/lifecycle/construction.js';
import type {
  LifecycleHydrateOwnedAuthorityRequest,
  LifecycleHydrateOwnedAuthorityResult,
  LifecycleWriteHandoffRequest,
} from '../../src/lifecycle/index.js';
import type {
  ExecutionPlanSource,
  ExecutionPlanSourceResult,
  LocalClock,
  LocalScheduler,
  ManagerIdSource,
  ManagerLifecycleIdempotencyPurpose,
  ScheduledTask,
} from '../../src/ports/index.js';
import type { AttemptHandoffReason, RunStore } from '../../src/storage/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import { attemptFixture, executingNodeFixture, runFixture } from '../support/store-fixtures.js';

const unavailableExecutors = {
  resolveExact: async () => ({
    fault: { code: 'EXECUTOR_UNAVAILABLE' as const, message: 'unused' },
    kind: 'unavailable' as const,
  }),
};

const createLifecycle = (store: RunStore) =>
  createRunLifecycle({ executors: unavailableExecutors, store });

const requestFor = (
  expectedPhase: LifecycleHydrateOwnedAuthorityRequest['expectedPhase'] = 'claimed',
): LifecycleHydrateOwnedAuthorityRequest => ({
  attemptId: 'attempt-1',
  expectedAttemptFence: 1,
  expectedManagerIncarnationId: 'manager-1',
  expectedPhase,
  nodeInstanceId: 'node-1',
  runId: 'run-1',
});

const seedAuthority = (
  transactionNow: number,
  phase: LifecycleHydrateOwnedAuthorityRequest['expectedPhase'] = 'claimed',
) => {
  const store = new LogicalRunStoreFake(transactionNow);
  const nodePhase = phase === 'claimed' || phase === 'start_committed' ? 'executing' : 'unknown';
  store.seed({
    attempts: [attemptFixture({ status: phase })],
    nodes: [executingNodeFixture(nodePhase)],
    runs: [runFixture()],
  });
  return store;
};

describe('manager enablement ports', () => {
  it('loads only a complete exact plan pin into a closed result', () => {
    expectTypeOf<Parameters<ExecutionPlanSource['loadExact']>[0]>().toEqualTypeOf<{
      readonly digest: string;
      readonly id: string;
      readonly revision: string;
    }>();
    expectTypeOf<Awaited<ReturnType<ExecutionPlanSource['loadExact']>>['kind']>().toEqualTypeOf<
      'fault' | 'loaded'
    >();
    expectTypeOf<
      Extract<ExecutionPlanSourceResult, { readonly kind: 'loaded' }>['planDocument']['pin']
    >().toEqualTypeOf<Parameters<ExecutionPlanSource['loadExact']>[0]>();
    expectTypeOf<
      Extract<ExecutionPlanSourceResult, { readonly kind: 'fault' }>['fault']['code']
    >().toEqualTypeOf<'NOT_FOUND' | 'PLAN_MISMATCH' | 'PLAN_UNAVAILABLE'>();
  });

  it('uses purpose-specific manager identifiers and local-only scheduling', () => {
    expectTypeOf<keyof ManagerIdSource>().toEqualTypeOf<
      | 'nextAttemptId'
      | 'nextHandoffId'
      | 'nextLifecycleIdempotencyKey'
      | 'nextManagerIncarnationId'
      | 'nextOutputId'
      | 'nextRunId'
      | 'nextProgressionOccurrenceKey'
      | 'nextProgressionAllocationSeed'
    >();
    expectTypeOf<ManagerLifecycleIdempotencyPurpose>().toEqualTypeOf<
      | 'acquire'
      | 'claim'
      | 'prepare_reconciliation'
      | 'process_execute_observation'
      | 'process_reconcile_observation'
      | 'progress_task_outcome'
      | 'verify_and_start'
      | 'write_handoff'
    >();
    expectTypeOf<LocalClock['now']>().returns.toBeNumber();
    expectTypeOf<LocalScheduler['enqueue']>().returns.toEqualTypeOf<ScheduledTask>();
    expectTypeOf<LocalScheduler['wait']>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<ScheduledTask['cancel']>().returns.toBeVoid();
  });

  it('allocates claim and dispatch keys from distinct semantic purposes', () => {
    const purposes: ManagerLifecycleIdempotencyPurpose[] = [];
    let sequence = 0;
    const ids: ManagerIdSource = {
      nextAttemptId: () => 'attempt',
      nextHandoffId: () => 'handoff',
      nextLifecycleIdempotencyKey: (purpose) => {
        purposes.push(purpose);
        sequence += 1;
        return `${purpose}-${sequence}`;
      },
      nextManagerIncarnationId: () => 'manager',
      nextOutputId: () => 'output',
      nextRunId: () => 'run',
      nextProgressionOccurrenceKey: () => 'occurrence',
      nextProgressionAllocationSeed: () => 'allocation',
    };

    const claimIdempotencyKey = ids.nextLifecycleIdempotencyKey('claim');
    const generatedDispatchIdempotencyKey = ids.nextLifecycleIdempotencyKey('verify_and_start');

    expect(purposes).toEqual(['claim', 'verify_and_start']);
    expect(claimIdempotencyKey).not.toBe(generatedDispatchIdempotencyKey);
  });
});

describe('owned lifecycle authority hydration', () => {
  it.each([
    ['claimed', 'executing', 'start'],
    ['start_committed', 'executing', 'reconcile'],
    ['unknown', 'unknown', 'reconcile'],
    ['reconciling', 'unknown', 'reconcile'],
  ] as const)(
    'hydrates fresh %s authority and derives %s/%s',
    async (phase, nodePhase, recovery) => {
      const lifecycle = createLifecycle(seedAuthority(2_000, phase));

      const result = await lifecycle.hydrateOwnedAuthority(requestFor(phase));

      expect(result).toMatchObject({
        kind: 'hydrated',
        transactionNow: 2_000,
        value: {
          authority: {
            attemptId: 'attempt-1',
            attemptPhase: phase,
            expectedAttemptRevision: 0,
            expectedNodeRevision: 0,
            expectedRunRevision: 0,
            fencingToken: 1,
            managerIncarnationId: 'manager-1',
            nodePhase,
          },
          phase,
          recovery,
        },
      });
      if (result.kind !== 'hydrated') return;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.authority)).toBe(true);
      expect('capability' in result.value).toBe(false);
    },
  );

  it('does not accept caller revisions or pins as hydration authority', () => {
    expectTypeOf<keyof LifecycleHydrateOwnedAuthorityRequest>().toEqualTypeOf<
      | 'attemptId'
      | 'expectedAttemptFence'
      | 'expectedManagerIncarnationId'
      | 'expectedPhase'
      | 'nodeInstanceId'
      | 'runId'
    >();
    expectTypeOf<LifecycleHydrateOwnedAuthorityResult['kind']>().toEqualTypeOf<
      'conflict' | 'fault' | 'hydrated'
    >();
  });

  it('maps a detached terminal Attempt with null active pointer to stale authority', async () => {
    const store = new LogicalRunStoreFake(2_000);
    store.seed({
      attempts: [attemptFixture({ status: 'succeeded' })],
      nodes: [{ ...executingNodeFixture(), activeAttemptId: null, status: 'succeeded' }],
      runs: [runFixture()],
    });

    await expect(createLifecycle(store).hydrateOwnedAuthority(requestFor())).resolves.toMatchObject(
      {
        conflict: { code: 'STALE_FENCE' },
        kind: 'conflict',
      },
    );
  });

  it('gives incumbent fence loss precedence over a successor phase', async () => {
    const store = new LogicalRunStoreFake(2_000);
    store.seed({
      attempts: [attemptFixture({ fencingToken: 2, status: 'start_committed' })],
      nodes: [executingNodeFixture()],
      runs: [runFixture()],
    });

    await expect(createLifecycle(store).hydrateOwnedAuthority(requestFor())).resolves.toMatchObject(
      {
        conflict: { code: 'STALE_FENCE' },
        kind: 'conflict',
      },
    );
  });

  it('gives durable handoff precedence over an incompatible phase', async () => {
    const store = new LogicalRunStoreFake(2_000);
    store.seed({
      attempts: [attemptFixture({ status: 'start_committed' })],
      handoffs: [
        {
          consumption: null,
          handoff: {
            activationId: 'activation-1',
            createdAt: 1_500,
            expectedAttemptRevision: 0,
            id: 'handoff-1',
            incumbentManagerIncarnationId: 'manager-1',
            key: { attemptId: 'attempt-1', incumbentFencingToken: 1 },
            nodeInstanceId: 'node-1',
            reason: 'manager_shutdown',
            runId: 'run-1',
          },
        },
      ],
      nodes: [executingNodeFixture()],
      runs: [runFixture()],
    });

    await expect(createLifecycle(store).hydrateOwnedAuthority(requestFor())).resolves.toMatchObject(
      {
        conflict: { code: 'STALE_FENCE' },
        kind: 'conflict',
      },
    );
  });

  it('captures transaction time from its data descriptor without a property get', async () => {
    const store = seedAuthority(2_000);
    let transactionNowGets = 0;
    const descriptorSafeStore: RunStore = {
      discover: (query) => store.discover(query),
      getRun: (runId) => store.getRun(runId),
      listRuns: (query) => store.listRuns(query),
      readEvents: (query) => store.readEvents(query),
      transaction: (callback) =>
        store.transaction((transaction) =>
          callback(
            new Proxy(transaction, {
              get: (target, property) => {
                if (property === 'transactionNow') {
                  transactionNowGets += 1;
                  throw new Error('transactionNow property get is forbidden');
                }
                switch (property) {
                  case 'getRun':
                    return target.getRun.bind(target);
                  case 'getNode':
                    return target.getNode.bind(target);
                  case 'getNodeByActivation':
                    return target.getNodeByActivation.bind(target);
                  case 'getAttempt':
                    return target.getAttempt.bind(target);
                  case 'listNodes':
                    return target.listNodes.bind(target);
                  case 'listAttempts':
                    return target.listAttempts.bind(target);
                  case 'listOutputs':
                    return target.listOutputs.bind(target);
                  case 'getIdempotency':
                    return target.getIdempotency.bind(target);
                  case 'getHandoff':
                    return target.getHandoff.bind(target);
                  case 'commit':
                    return target.commit.bind(target);
                  default:
                    return undefined;
                }
              },
            }),
          ),
        ),
    };

    await expect(
      createLifecycle(descriptorSafeStore).hydrateOwnedAuthority(requestFor()),
    ).resolves.toMatchObject({ kind: 'hydrated', transactionNow: 2_000 });
    expect(transactionNowGets).toBe(0);
  });

  it.each([
    ['active attempt', { node: { activeAttemptId: 'other-attempt' } }, 'STALE_FENCE'],
    ['manager incarnation', { attempt: { managerIncarnationId: 'manager-2' } }, 'STALE_FENCE'],
    ['fence', { attempt: { fencingToken: 2 } }, 'STALE_FENCE'],
    ['phase', { attempt: { status: 'start_committed' } }, 'INVALID_STATE'],
    ['run correlation', { attempt: { runId: 'other-run' } }, 'STALE_FENCE'],
    ['node correlation', { attempt: { nodeInstanceId: 'other-node' } }, 'STALE_FENCE'],
  ] as const)('rejects stale %s', async (_label, changes, code) => {
    const store = new LogicalRunStoreFake(2_000);
    const attemptChanges = 'attempt' in changes ? changes.attempt : {};
    const nodeChanges = 'node' in changes ? changes.node : {};
    store.seed({
      attempts: [attemptFixture(attemptChanges)],
      nodes: [executingNodeFixture('executing', nodeChanges)],
      runs: [runFixture()],
    });

    await expect(createLifecycle(store).hydrateOwnedAuthority(requestFor())).resolves.toMatchObject(
      {
        conflict: { code },
        kind: 'conflict',
      },
    );
  });

  it('treats lease equality as expired and does not use local time', async () => {
    const before = createLifecycle(seedAuthority(2_999));
    const equal = createLifecycle(seedAuthority(3_000));

    await expect(before.hydrateOwnedAuthority(requestFor())).resolves.toMatchObject({
      kind: 'hydrated',
    });
    await expect(equal.hydrateOwnedAuthority(requestFor())).resolves.toMatchObject({
      conflict: { code: 'STALE_FENCE' },
      kind: 'conflict',
    });
  });

  it('rejects an incumbent handoff and performs no write', async () => {
    const store = seedAuthority(2_000);
    store.seed({
      handoffs: [
        {
          consumption: null,
          handoff: {
            activationId: 'activation-1',
            createdAt: 1_500,
            expectedAttemptRevision: 0,
            id: 'handoff-1',
            incumbentManagerIncarnationId: 'manager-1',
            key: { attemptId: 'attempt-1', incumbentFencingToken: 1 },
            nodeInstanceId: 'node-1',
            reason: 'manager_shutdown',
            runId: 'run-1',
          },
        },
      ],
    });
    let commitCalls = 0;
    const readOnlyStore: RunStore = {
      discover: (query) => store.discover(query),
      getRun: (runId) => store.getRun(runId),
      listRuns: (query) => store.listRuns(query),
      readEvents: (query) => store.readEvents(query),
      transaction: (callback) =>
        store.transaction((transaction) =>
          callback({
            ...transaction,
            commit: async (command) => {
              commitCalls += 1;
              return transaction.commit(command);
            },
          }),
        ),
    };

    await expect(
      createLifecycle(readOnlyStore).hydrateOwnedAuthority(requestFor()),
    ).resolves.toMatchObject({
      conflict: { code: 'STALE_FENCE' },
      kind: 'conflict',
    });
    expect(commitCalls).toBe(0);
  });

  it('rejects hostile request and Store snapshots without invoking getters', async () => {
    let getterCalls = 0;
    const hostileRequest = requestFor();
    Object.defineProperty(hostileRequest, 'runId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'run-1';
      },
    });
    const lifecycle = createLifecycle(seedAuthority(2_000));
    await expect(lifecycle.hydrateOwnedAuthority(hostileRequest)).resolves.toMatchObject({
      fault: { code: 'INVALID_INPUT' },
      kind: 'fault',
    });

    const store = seedAuthority(2_000);
    const hostileAttempt = { ...attemptFixture() };
    Object.defineProperty(hostileAttempt, 'managerIncarnationId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'manager-1';
      },
    });
    const hostileStore: RunStore = {
      discover: (query) => store.discover(query),
      getRun: (runId) => store.getRun(runId),
      listRuns: (query) => store.listRuns(query),
      readEvents: (query) => store.readEvents(query),
      transaction: (callback) =>
        store.transaction((transaction) =>
          callback({
            ...transaction,
            getAttempt: async () => ({ kind: 'found', value: hostileAttempt }),
          }),
        ),
    };

    await expect(
      createLifecycle(hostileStore).hydrateOwnedAuthority(requestFor()),
    ).resolves.toMatchObject({ fault: { code: 'INVALID_INPUT' }, kind: 'fault' });
    expect(getterCalls).toBe(0);
  });

  it('does not misclassify a Store provider failure as invalid input', async () => {
    const store = seedAuthority(2_000);
    const rejectingStore: RunStore = {
      discover: (query) => store.discover(query),
      getRun: (runId) => store.getRun(runId),
      listRuns: (query) => store.listRuns(query),
      readEvents: (query) => store.readEvents(query),
      transaction: (callback) =>
        store.transaction((transaction) =>
          callback({
            ...transaction,
            getAttempt: async () => {
              throw new TypeError('provider read failed');
            },
          }),
        ),
    };

    await expect(
      createLifecycle(rejectingStore).hydrateOwnedAuthority(requestFor()),
    ).rejects.toThrow('provider read failed');
  });
});

describe('manager-owned durable handoff reasons', () => {
  it('keeps storage and lifecycle on the same closed reason set', () => {
    expectTypeOf<AttemptHandoffReason>().toEqualTypeOf<
      | 'manager_progression_unavailable'
      | 'manager_recovery_failure'
      | 'manager_shutdown'
      | 'manager_start_failure'
    >();
    expectTypeOf<LifecycleWriteHandoffRequest['reason']>().toEqualTypeOf<AttemptHandoffReason>();
  });

  it.each(['manager_progression_unavailable', 'manager_recovery_failure'] as const)(
    'commits and replays %s with the exact durable record and event reason',
    async (reason) => {
      const store = seedAuthority(2_000);
      const lifecycle = createLifecycle(store);
      const request = {
        authority: {
          activationId: 'activation-1',
          attemptId: 'attempt-1',
          attemptPhase: 'claimed' as const,
          dispatchIdempotencyKey: 'dispatch-1',
          executorConfigurationDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
          executorContractPin: {
            adapterId: 'executor',
            digest: 'executor-digest',
            revision: '1',
          },
          expectedAttemptRevision: 0,
          expectedNodeRevision: 0,
          expectedRunRevision: 0,
          fencingToken: 1,
          leaseExpiresAt: 3_000,
          managerIncarnationId: 'manager-1',
          nodeInstanceId: 'node-1',
          nodeKey: 'node',
          nodePhase: 'executing' as const,
          planPin: { digest: 'plan-digest', id: 'plan', revision: '1' },
          runId: 'run-1',
        },
        generatedHandoffId: `handoff-${reason}`,
        idempotencyKey: `idempotency-${reason}`,
        reason,
      };

      await expect(lifecycle.writeHandoff(request)).resolves.toMatchObject({
        kind: 'committed',
        value: { handoffId: `handoff-${reason}` },
      });
      await expect(lifecycle.writeHandoff(request)).resolves.toMatchObject({
        kind: 'replayed',
        value: { handoffId: `handoff-${reason}` },
      });
      const otherReason =
        reason === 'manager_progression_unavailable'
          ? 'manager_recovery_failure'
          : 'manager_progression_unavailable';
      await expect(
        lifecycle.writeHandoff({ ...request, reason: otherReason }),
      ).resolves.toMatchObject({
        conflict: { code: 'IDEMPOTENCY_CONFLICT' },
        kind: 'conflict',
      });
      await expect(
        store.transaction((transaction) =>
          transaction.getHandoff({
            attemptId: 'attempt-1',
            incumbentFencingToken: 1,
          }),
        ),
      ).resolves.toMatchObject({
        kind: 'found',
        value: { handoff: { reason } },
      });
      await expect(
        store.readEvents({
          limit: 10,
          runId: 'run-1',
          scan: { after: { runId: 'run-1', sequence: 0 }, kind: 'start' },
        }),
      ).resolves.toMatchObject({
        kind: 'page',
        page: {
          items: [{ kind: 'attempt.handoff_recorded', payload: { reason } }],
        },
      });
    },
  );
});
