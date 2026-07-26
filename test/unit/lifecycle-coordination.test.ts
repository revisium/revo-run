import { describe, expect, it } from 'vitest';

import { createRunLifecycle } from '../../src/lifecycle/construction.js';
import type { LifecycleAttemptAuthority } from '../../src/lifecycle/index.js';
import { snapshotExecutorConfiguration } from '../../src/policy/index.js';
import type {
  RunStore,
  RunStoreCommitResult,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
} from '../../src/storage/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  attemptFixture,
  executingNodeFixture,
  nodeFixture,
  planPin,
  runFixture,
} from '../support/store-fixtures.js';

const leasePolicy = { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 };
const configuration = { model: 'stable' };
const configurationDigest = snapshotExecutorConfiguration(configuration).digest;
const alternativeConfigurationDigest = snapshotExecutorConfiguration({ model: 'other' }).digest;
const planBinding = {
  configuration,
  configurationDigest,
  executor: { adapterId: 'executor', digest: 'executor-digest', revision: '1' },
  idempotentExecution: false,
  nodeKey: 'node',
  retryPolicy: {
    backoffMultiplier: 2,
    initialBackoffMs: 1_000,
    maximumAttempts: 3,
    maximumBackoffMs: 10_000,
  },
  timeoutPolicy: {
    cancellationTimeoutMs: 60_000,
    executionTimeoutMs: 60_000,
    reconciliationTimeoutMs: 60_000,
  },
};
const planDocument = {
  compiledPipeline: { ignored: true },
  executorBindings: [planBinding],
  pin: planPin,
};

const planWithMaximumAttempts = (maximumAttempts: number) => ({
  ...planDocument,
  executorBindings: planDocument.executorBindings.map((binding) => ({
    ...binding,
    retryPolicy: { ...binding.retryPolicy, maximumAttempts },
  })),
});

const authorityValue: LifecycleAttemptAuthority = {
  activationId: 'activation-1',
  attemptId: 'attempt-1',
  attemptPhase: 'claimed',
  dispatchIdempotencyKey: 'dispatch-1',
  executorConfigurationDigest: configurationDigest,
  executorContractPin: planBinding.executor,
  expectedAttemptRevision: 0,
  expectedNodeRevision: 1,
  expectedRunRevision: 0,
  fencingToken: 1,
  leaseExpiresAt: 3_000,
  managerIncarnationId: 'manager-1',
  nodeInstanceId: 'node-1',
  nodeKey: 'node',
  nodePhase: 'executing',
  planPin,
  runId: 'run-1',
};

const expiredCandidate = {
  attempt: {
    attemptId: 'attempt-1',
    attemptPhase: 'claimed' as const,
    attemptRevision: 0,
    fencingToken: 1,
    leaseExpiresAt: 3_000,
    managerIncarnationId: 'manager-1',
  },
  eligibleAt: 3_000,
  handoffId: null,
  kind: 'expired_attempt' as const,
  node: {
    activeAttemptId: 'attempt-1',
    nodeInstanceId: 'node-1',
    nodeRevision: 1,
  },
  run: { planPin, runId: 'run-1', runRevision: 0 },
};

const readIdempotency = async (
  store: LogicalRunStoreFake,
  identity: RunStoreIdempotencyIdentity,
): Promise<RunStoreIdempotencyRecord> =>
  store.transaction(async (transaction) => {
    const result = await transaction.getIdempotency(identity);
    if (result.kind !== 'found') throw new Error('Expected idempotency record.');
    return result.value;
  });

const setJsonMember = (
  value: RunStoreIdempotencyRecord['result'],
  key: string,
  replacement: string,
): void => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected idempotency result record.');
  }
  Reflect.set(value, key, replacement);
};

const withInjectedCommitResult = (
  store: LogicalRunStoreFake,
  result: RunStoreCommitResult,
): RunStore => ({
  discover: (query) => store.discover(query),
  getRun: (runId) => store.getRun(runId),
  listRuns: (query) => store.listRuns(query),
  readEvents: (query) => store.readEvents(query),
  transaction: (callback) =>
    store.transaction((transaction) =>
      callback({
        ...transaction,
        commit: async () => result,
      }),
    ),
});

describe('lifecycle coordination', () => {
  const invalidResult = {
    fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
    kind: 'fault',
  } as const;

  it('constructs the exact operational facade from Store-only dependencies', () => {
    const lifecycle = createRunLifecycle({
      store: {
        discover: async () => {
          throw new Error('unused');
        },
        getRun: async () => ({ kind: 'not_found' }),
        listRuns: async () => {
          throw new Error('unused');
        },
        readEvents: async () => {
          throw new Error('unused');
        },
        transaction: async () => {
          throw new Error('unused');
        },
      },
    });

    expect(Object.keys(lifecycle).sort()).toEqual([
      'acquire',
      'claim',
      'discover',
      'renewLease',
      'writeHandoff',
    ]);
  });

  it('claims only authoritative running and currently eligible nodes', async () => {
    const candidateFor = (
      run: ReturnType<typeof runFixture>,
      node: ReturnType<typeof nodeFixture>,
    ) => ({
      attempt: null,
      eligibleAt: node.retryAvailableAt ?? node.updatedAt,
      handoffId: null,
      kind: 'claimable_node' as const,
      node: {
        activeAttemptId: null,
        nodeInstanceId: node.id,
        nodeRevision: node.revision,
      },
      run: { planPin: run.planPin, runId: run.id, runRevision: run.revision },
    });
    const claimAt = async (
      transactionNow: number,
      run: ReturnType<typeof runFixture>,
      node: ReturnType<typeof nodeFixture>,
    ) => {
      const store = new LogicalRunStoreFake(transactionNow);
      store.seed({ nodes: [node], runs: [run] });
      const result = await createRunLifecycle({ store }).claim({
        candidate: candidateFor(run, node),
        generatedAttemptId: 'attempt-eligibility',
        generatedDispatchIdempotencyKey: 'dispatch-eligibility',
        idempotencyKey: 'claim-eligibility',
        leasePolicy,
        managerIncarnationId: 'manager-1',
        ownerLabel: 'manager one',
        planDocument,
      });
      return { result, store };
    };

    const future = await claimAt(
      1_500,
      runFixture(),
      nodeFixture({ retryAvailableAt: 1_501, status: 'retry_waiting' }),
    );
    expect(future.result).toMatchObject({
      conflict: { code: 'INVALID_STATE' },
      kind: 'conflict',
    });
    await expect(
      future.store.transaction((transaction) => transaction.getAttempt('attempt-eligibility')),
    ).resolves.toEqual({ kind: 'not_found' });

    await expect(
      claimAt(
        1_500,
        runFixture({
          cancellationRequestedAt: 1_200,
          status: 'cancelling',
          updatedAt: 1_200,
        }),
        nodeFixture(),
      ).then(({ result }) => result),
    ).resolves.toMatchObject({ conflict: { code: 'INVALID_STATE' }, kind: 'conflict' });
    await expect(
      claimAt(1_500, runFixture(), nodeFixture({ status: 'gate_waiting' })).then(
        ({ result }) => result,
      ),
    ).resolves.toMatchObject({ conflict: { code: 'INVALID_STATE' }, kind: 'conflict' });

    await expect(
      claimAt(
        1_500,
        runFixture(),
        nodeFixture({ retryAvailableAt: 1_500, status: 'retry_waiting' }),
      ).then(({ result }) => result),
    ).resolves.toMatchObject({ kind: 'committed' });
  });

  it('strictly maps deterministic commit-time claim replays', async () => {
    const source = new LogicalRunStoreFake(1_500);
    source.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    const sourceLifecycle = createRunLifecycle({ store: source });
    const discovery = await sourceLifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    if (candidate?.kind !== 'claimable_node') return;
    const request = {
      candidate,
      generatedAttemptId: 'commit-replay-attempt',
      generatedDispatchIdempotencyKey: 'commit-replay-dispatch',
      idempotencyKey: 'commit-replay-key',
      leasePolicy,
      managerIncarnationId: 'commit-replay-manager',
      ownerLabel: 'commit replay manager',
      planDocument,
    };
    await sourceLifecycle.claim(request);
    const identity = {
      key: request.idempotencyKey,
      operation: 'claim_attempt' as const,
      runId: 'run-1',
      subjectId: 'node-1',
    };
    const record = await readIdempotency(source, identity);

    const replayBase = new LogicalRunStoreFake(1_500);
    replayBase.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    await expect(
      createRunLifecycle({
        store: withInjectedCommitResult(replayBase, { kind: 'replayed', record }),
      }).claim(request),
    ).resolves.toMatchObject({
      kind: 'replayed',
      value: { attemptId: request.generatedAttemptId, ordinal: 0 },
    });

    const malformed = structuredClone(record);
    if (malformed.result === null || typeof malformed.result !== 'object') return;
    Reflect.set(malformed.result, 'ordinal', 'zero');
    const malformedBase = new LogicalRunStoreFake(1_500);
    malformedBase.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    await expect(
      createRunLifecycle({
        store: withInjectedCommitResult(malformedBase, { kind: 'replayed', record: malformed }),
      }).claim(request),
    ).resolves.toEqual(invalidResult);
    await expect(
      malformedBase.transaction((transaction) =>
        transaction.getAttempt(request.generatedAttemptId),
      ),
    ).resolves.toEqual({ kind: 'not_found' });

    const mismatched = structuredClone(record);
    if (mismatched.request === null || typeof mismatched.request !== 'object') return;
    Reflect.set(mismatched.request, 'ownerLabel', 'different owner');
    const mismatchBase = new LogicalRunStoreFake(1_500);
    mismatchBase.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    await expect(
      createRunLifecycle({
        store: withInjectedCommitResult(mismatchBase, { kind: 'replayed', record: mismatched }),
      }).claim(request),
    ).resolves.toMatchObject({
      conflict: { code: 'IDEMPOTENCY_CONFLICT' },
      kind: 'conflict',
    });
  });

  it('discovers, claims, renews, hands off, and acquires with Store transaction time', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    const lifecycle = createRunLifecycle({ store });

    const discovery = await lifecycle.discover({
      kinds: ['claimable_node'],
      limit: 10,
      renewal: null,
      scan: { kind: 'start' },
    });
    expect(discovery.kind).toBe('page');
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    expect(candidate?.kind).toBe('claimable_node');
    if (candidate?.kind !== 'claimable_node') return;

    const claimRequest = {
      candidate,
      generatedAttemptId: 'attempt-lifecycle',
      generatedDispatchIdempotencyKey: 'dispatch-lifecycle',
      idempotencyKey: 'claim-lifecycle',
      leasePolicy,
      managerIncarnationId: 'manager-1',
      ownerLabel: 'manager one',
      planDocument,
    };
    const claimed = await lifecycle.claim(claimRequest);
    expect(claimed).toMatchObject({
      kind: 'committed',
      transactionNow: 1_500,
      value: {
        authority: {
          attemptPhase: 'claimed',
          fencingToken: 1,
          leaseExpiresAt: 3_500,
          nodePhase: 'executing',
        },
        ordinal: 0,
      },
    });
    if (claimed.kind !== 'committed') return;
    await expect(lifecycle.claim(claimRequest)).resolves.toMatchObject({
      kind: 'replayed',
      value: {
        attemptId: 'attempt-lifecycle',
        fencingToken: 1,
        ordinal: 0,
      },
    });
    await expect(
      lifecycle.claim({
        ...claimRequest,
        planDocument: { ...planDocument, compiledPipeline: { changedButExcluded: true } },
      }),
    ).resolves.toMatchObject({
      kind: 'replayed',
      value: { attemptId: 'attempt-lifecycle', ordinal: 0 },
    });
    await expect(
      lifecycle.claim({ ...claimRequest, ownerLabel: 'different manager label' }),
    ).resolves.toMatchObject({
      conflict: { code: 'IDEMPOTENCY_CONFLICT' },
      kind: 'conflict',
    });
    await expect(
      lifecycle.claim({
        ...claimRequest,
        generatedAttemptId: 'competing-attempt',
        idempotencyKey: 'competing-claim',
      }),
    ).resolves.toMatchObject({
      conflict: { code: 'REVISION_CONFLICT' },
      kind: 'conflict',
    });

    const renewed = await lifecycle.renewLease({
      authority: claimed.value.authority,
      leasePolicy,
    });
    expect(renewed).toMatchObject({
      kind: 'committed',
      value: { authority: { expectedAttemptRevision: 1 }, lastHeartbeatAt: 1_500 },
    });
    if (renewed.kind !== 'committed') return;

    const handoffRequest = {
      authority: renewed.value.authority,
      generatedHandoffId: 'handoff-lifecycle',
      idempotencyKey: 'handoff-key',
      reason: 'manager_shutdown' as const,
    };
    await expect(
      lifecycle.acquire({
        candidate: {
          attempt: {
            attemptId: renewed.value.authority.attemptId,
            attemptPhase: renewed.value.authority.attemptPhase,
            attemptRevision: renewed.value.authority.expectedAttemptRevision,
            fencingToken: renewed.value.authority.fencingToken,
            leaseExpiresAt: renewed.value.authority.leaseExpiresAt,
            managerIncarnationId: renewed.value.authority.managerIncarnationId,
          },
          eligibleAt: renewed.value.authority.leaseExpiresAt,
          handoffId: null,
          kind: 'expired_attempt',
          node: {
            activeAttemptId: renewed.value.authority.attemptId,
            nodeInstanceId: renewed.value.authority.nodeInstanceId,
            nodeRevision: renewed.value.authority.expectedNodeRevision,
          },
          run: {
            planPin: renewed.value.authority.planPin,
            runId: renewed.value.authority.runId,
            runRevision: renewed.value.authority.expectedRunRevision,
          },
        },
        idempotencyKey: 'premature-acquire',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toMatchObject({ conflict: { code: 'STALE_FENCE' }, kind: 'conflict' });
    const handedOff = await lifecycle.writeHandoff(handoffRequest);
    expect(handedOff).toMatchObject({
      kind: 'committed',
      value: { handoffId: 'handoff-lifecycle', incumbentFencingToken: 1 },
    });
    await expect(
      lifecycle.writeHandoff({
        authority: renewed.value.authority,
        generatedHandoffId: 'handoff-lifecycle',
        idempotencyKey: 'handoff-key',
        reason: 'manager_shutdown',
      }),
    ).resolves.toMatchObject({
      kind: 'replayed',
      value: { handoffId: 'handoff-lifecycle' },
    });
    const changedHandoffRequests = [
      ['generated handoff id', { ...handoffRequest, generatedHandoffId: 'handoff-other' }],
      ['reason', { ...handoffRequest, reason: 'manager_start_failure' as const }],
      [
        'Run revision',
        {
          ...handoffRequest,
          authority: {
            ...handoffRequest.authority,
            expectedRunRevision: handoffRequest.authority.expectedRunRevision + 1,
          },
        },
      ],
      [
        'configuration digest',
        {
          ...handoffRequest,
          authority: {
            ...handoffRequest.authority,
            executorConfigurationDigest: alternativeConfigurationDigest,
          },
        },
      ],
      [
        'plan pin',
        {
          ...handoffRequest,
          authority: {
            ...handoffRequest.authority,
            planPin: { ...handoffRequest.authority.planPin, revision: 'changed' },
          },
        },
      ],
    ] as const;
    await Promise.all(
      changedHandoffRequests.map(([, changedRequest]) =>
        expect(lifecycle.writeHandoff(changedRequest)).resolves.toMatchObject({
          conflict: { code: 'IDEMPOTENCY_CONFLICT' },
          kind: 'conflict',
        }),
      ),
    );

    const recoveryDiscovery = await lifecycle.discover({
      kinds: ['handoff_attempt'],
      limit: 10,
      renewal: null,
      scan: { kind: 'start' },
    });
    expect(recoveryDiscovery.kind).toBe('page');
    if (recoveryDiscovery.kind !== 'page') return;
    const recoveryCandidate = recoveryDiscovery.page.items[0];
    expect(recoveryCandidate?.kind).toBe('handoff_attempt');
    if (recoveryCandidate?.kind !== 'handoff_attempt') return;

    const acquireRequest = {
      candidate: recoveryCandidate,
      idempotencyKey: 'acquire-key',
      leasePolicy,
      successorManagerIncarnationId: 'manager-2',
    };
    const acquired = await lifecycle.acquire(acquireRequest);
    expect(acquired).toMatchObject({
      kind: 'committed',
      value: {
        authority: {
          expectedAttemptRevision: 2,
          fencingToken: 2,
          managerIncarnationId: 'manager-2',
        },
        evidence: { handoffId: 'handoff-lifecycle', kind: 'handoff' },
        recovery: 'start',
      },
    });
    await expect(
      lifecycle.acquire({
        candidate: recoveryCandidate,
        idempotencyKey: 'acquire-key',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toMatchObject({
      kind: 'replayed',
      value: { successorFencingToken: 2, successorManagerIncarnationId: 'manager-2' },
    });
    await expect(
      lifecycle.acquire({ ...acquireRequest, idempotencyKey: 'consumed-handoff-acquire' }),
    ).resolves.toMatchObject({ conflict: { code: 'STALE_FENCE' }, kind: 'conflict' });
    await expect(
      lifecycle.acquire({
        ...acquireRequest,
        idempotencyKey: 'incumbent-successor',
        successorManagerIncarnationId: 'manager-1',
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.writeHandoff({
        ...handoffRequest,
        generatedHandoffId: 'stale-authority-handoff',
        idempotencyKey: 'stale-authority-handoff',
      }),
    ).resolves.toMatchObject({ conflict: { code: 'STALE_FENCE' }, kind: 'conflict' });
    const changedAcquireCandidates = [
      { ...recoveryCandidate, eligibleAt: recoveryCandidate.eligibleAt + 1 },
      {
        ...recoveryCandidate,
        run: { ...recoveryCandidate.run, runRevision: recoveryCandidate.run.runRevision + 1 },
      },
      {
        ...recoveryCandidate,
        node: { ...recoveryCandidate.node, nodeRevision: recoveryCandidate.node.nodeRevision + 1 },
      },
      {
        ...recoveryCandidate,
        attempt: {
          ...recoveryCandidate.attempt,
          attemptRevision: recoveryCandidate.attempt.attemptRevision + 1,
        },
      },
      {
        ...recoveryCandidate,
        attempt: {
          ...recoveryCandidate.attempt,
          managerIncarnationId: 'manager-other',
        },
      },
      {
        ...recoveryCandidate,
        attempt: {
          ...recoveryCandidate.attempt,
          fencingToken: recoveryCandidate.attempt.fencingToken + 1,
        },
      },
      {
        ...recoveryCandidate,
        attempt: {
          ...recoveryCandidate.attempt,
          leaseExpiresAt: recoveryCandidate.attempt.leaseExpiresAt + 1,
        },
      },
    ];
    await Promise.all(
      changedAcquireCandidates.map((changedCandidate) =>
        expect(
          lifecycle.acquire({ ...acquireRequest, candidate: changedCandidate }),
        ).resolves.toMatchObject({
          conflict: { code: 'IDEMPOTENCY_CONFLICT' },
          kind: 'conflict',
        }),
      ),
    );
  });

  it('rejects lease expiry equality and never treats an authority observation as authority', async () => {
    const store = new LogicalRunStoreFake(3_000);
    const lifecycle = createRunLifecycle({ store });
    const run = runFixture();
    const node = nodeFixture({
      activeAttemptId: 'attempt-1',
      revision: 1,
      status: 'executing',
    });
    const authority: LifecycleAttemptAuthority = {
      activationId: node.activationId,
      attemptId: 'attempt-1',
      attemptPhase: 'claimed',
      dispatchIdempotencyKey: 'dispatch-1',
      executorConfigurationDigest: configurationDigest,
      executorContractPin: {
        adapterId: 'executor',
        digest: 'executor-digest',
        revision: '1',
      },
      expectedAttemptRevision: 0,
      expectedNodeRevision: 1,
      expectedRunRevision: 0,
      fencingToken: 1,
      leaseExpiresAt: 3_000,
      managerIncarnationId: 'manager-1',
      nodeInstanceId: node.id,
      nodeKey: node.nodeKey,
      nodePhase: 'executing',
      planPin,
      runId: run.id,
    };
    store.seed({
      attempts: [
        {
          createdAt: 1_000,
          dispatchIdempotencyKey: 'dispatch-1',
          executorConfigurationDigest: configurationDigest,
          executorContractPin: authority.executorContractPin,
          fault: null,
          fencingToken: 1,
          id: 'attempt-1',
          lastHeartbeatAt: 1_000,
          leaseExpiresAt: 3_000,
          managerIncarnationId: 'manager-1',
          nodeInstanceId: node.id,
          ordinal: 0,
          ownerLabel: 'owner',
          revision: 0,
          runId: run.id,
          startCommittedAt: null,
          status: 'claimed',
          terminalAt: null,
          updatedAt: 1_000,
        },
      ],
      nodes: [node],
      runs: [run],
    });

    await expect(lifecycle.renewLease({ authority, leasePolicy })).resolves.toMatchObject({
      conflict: { code: 'STALE_FENCE' },
      kind: 'conflict',
    });
  });

  it('maps malformed discovery and plan snapshots to fixed invalid input faults', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const lifecycle = createRunLifecycle({ store });
    await expect(
      lifecycle.discover({
        kinds: ['claimable_node', 'claimable_node'],
        limit: 1,
        renewal: null,
        scan: { kind: 'start' },
      }),
    ).resolves.toEqual({
      fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
      kind: 'fault',
    });
  });

  it('copies and freezes the remaining discovery variants and preserves cursor scans', async () => {
    const store = new LogicalRunStoreFake(3_000);
    store.seed({
      attempts: [
        attemptFixture({
          id: 'attempt-expired',
          leaseExpiresAt: 2_900,
          nodeInstanceId: 'node-expired',
        }),
        attemptFixture({
          id: 'attempt-renewable',
          leaseExpiresAt: 4_000,
          managerIncarnationId: 'manager-renewal',
          nodeInstanceId: 'node-renewable',
        }),
      ],
      nodes: [
        executingNodeFixture('executing', {
          activeAttemptId: 'attempt-expired',
          id: 'node-expired',
        }),
        executingNodeFixture('executing', {
          activeAttemptId: 'attempt-renewable',
          id: 'node-renewable',
        }),
      ],
      runs: [
        runFixture(),
        runFixture({
          cancellationRequestedAt: 1_200,
          id: 'run-cancelling',
          status: 'cancelling',
          updatedAt: 1_200,
        }),
        runFixture({ id: 'run-progress-2', updatedAt: 1_100 }),
      ],
    });
    const lifecycle = createRunLifecycle({ store });

    const attempts = await lifecycle.discover({
      kinds: ['expired_attempt', 'renewable_attempt'],
      limit: 10,
      renewal: { leasePolicy, managerIncarnationId: 'manager-renewal' },
      scan: { kind: 'start' },
    });
    expect(attempts).toMatchObject({
      kind: 'page',
      page: {
        items: [{ kind: 'renewable_attempt' }, { kind: 'expired_attempt' }],
      },
    });
    if (attempts.kind !== 'page') return;
    expect(Object.isFrozen(attempts.page)).toBe(true);
    expect(Object.isFrozen(attempts.page.items)).toBe(true);
    expect(Object.isFrozen(attempts.page.items[0]?.attempt)).toBe(true);

    const firstRuns = await lifecycle.discover({
      kinds: ['cancellation_run', 'progressable_run'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    expect(firstRuns).toMatchObject({
      kind: 'page',
      page: { items: [{ kind: 'progressable_run' }] },
    });
    if (firstRuns.kind !== 'page' || firstRuns.page.next === null) return;
    expect(Object.isFrozen(firstRuns.page.next)).toBe(true);
    const nextRuns = await lifecycle.discover({
      kinds: ['cancellation_run', 'progressable_run'],
      limit: 10,
      renewal: null,
      scan: { cursor: firstRuns.page.next, kind: 'continue' },
    });
    expect(nextRuns.kind).toBe('page');
    if (nextRuns.kind !== 'page') return;
    expect(nextRuns.page.items.map((item) => item.kind)).toEqual([
      'progressable_run',
      'cancellation_run',
    ]);

    const repeated = await lifecycle.discover({
      kinds: ['expired_attempt'],
      limit: 10,
      renewal: null,
      scan: { kind: 'start' },
    });
    expect(repeated).toMatchObject({
      kind: 'page',
      page: { items: [{ attempt: { attemptId: 'attempt-expired' }, kind: 'expired_attempt' }] },
    });
  });

  it.each([
    {
      attemptPhase: 'claimed' as const,
      expectedAttemptPhase: 'claimed',
      expectedNodePhase: 'executing',
      expectedRevisionDelta: 0,
      nodePhase: 'executing' as const,
      recovery: 'start',
    },
    {
      attemptPhase: 'start_committed' as const,
      expectedAttemptPhase: 'unknown',
      expectedNodePhase: 'unknown',
      expectedRevisionDelta: 1,
      nodePhase: 'executing' as const,
      recovery: 'reconcile',
    },
    {
      attemptPhase: 'unknown' as const,
      expectedAttemptPhase: 'unknown',
      expectedNodePhase: 'unknown',
      expectedRevisionDelta: 0,
      nodePhase: 'unknown' as const,
      recovery: 'reconcile',
    },
    {
      attemptPhase: 'reconciling' as const,
      expectedAttemptPhase: 'unknown',
      expectedNodePhase: 'unknown',
      expectedRevisionDelta: 0,
      nodePhase: 'unknown' as const,
      recovery: 'reconcile',
    },
  ])(
    'maps expired $attemptPhase ownership to $expectedAttemptPhase/$expectedNodePhase',
    async ({
      attemptPhase,
      expectedAttemptPhase,
      expectedNodePhase,
      expectedRevisionDelta,
      nodePhase,
      recovery,
    }) => {
      const store = new LogicalRunStoreFake(3_000);
      const run = runFixture();
      const node = executingNodeFixture(nodePhase, { revision: 1 });
      const attempt = attemptFixture({
        leaseExpiresAt: 2_900,
        status: attemptPhase,
      });
      store.seed({ attempts: [attempt], nodes: [node], runs: [run] });
      const lifecycle = createRunLifecycle({ store });
      const discovery = await lifecycle.discover({
        kinds: ['expired_attempt'],
        limit: 1,
        renewal: null,
        scan: { kind: 'start' },
      });
      expect(discovery.kind).toBe('page');
      if (discovery.kind !== 'page') return;
      const candidate = discovery.page.items[0];
      expect(candidate?.kind).toBe('expired_attempt');
      if (candidate?.kind !== 'expired_attempt') return;

      const result = await lifecycle.acquire({
        candidate,
        idempotencyKey: `acquire-${attemptPhase}`,
        leasePolicy,
        successorManagerIncarnationId: 'manager-successor',
      });
      expect(result).toMatchObject({
        kind: 'committed',
        value: {
          authority: {
            attemptPhase: expectedAttemptPhase,
            expectedAttemptRevision: 1,
            expectedNodeRevision: node.revision + expectedRevisionDelta,
            expectedRunRevision: run.revision + expectedRevisionDelta,
            fencingToken: 2,
            nodePhase: expectedNodePhase,
          },
          evidence: { kind: 'lease_expired' },
          recovery,
        },
      });
    },
  );

  it('derives ordinal 99 from complete bounded history and enforces retry exhaustion', async () => {
    const history = Array.from({ length: 99 }, (_, ordinal) =>
      attemptFixture({
        id: `attempt-history-${ordinal.toString().padStart(2, '0')}`,
        ordinal,
        status: 'succeeded',
      }),
    );
    const store = new LogicalRunStoreFake(1_500);
    store.seed({ attempts: history, nodes: [nodeFixture()], runs: [runFixture()] });
    const lifecycle = createRunLifecycle({ store });
    const discovery = await lifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    expect(discovery.kind).toBe('page');
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    expect(candidate?.kind).toBe('claimable_node');
    if (candidate?.kind !== 'claimable_node') return;

    await expect(
      lifecycle.claim({
        candidate,
        generatedAttemptId: 'attempt-history-99',
        generatedDispatchIdempotencyKey: 'dispatch-history-99',
        idempotencyKey: 'claim-history-99',
        leasePolicy,
        managerIncarnationId: 'manager-history',
        ownerLabel: 'history manager',
        planDocument: planWithMaximumAttempts(100),
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: { ordinal: 99 },
    });

    const exhaustedStore = new LogicalRunStoreFake(1_500);
    exhaustedStore.seed({
      attempts: [attemptFixture({ status: 'succeeded' })],
      nodes: [nodeFixture()],
      runs: [runFixture()],
    });
    const exhaustedLifecycle = createRunLifecycle({ store: exhaustedStore });
    const exhaustedDiscovery = await exhaustedLifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    expect(exhaustedDiscovery.kind).toBe('page');
    if (exhaustedDiscovery.kind !== 'page') return;
    const exhaustedCandidate = exhaustedDiscovery.page.items[0];
    if (exhaustedCandidate?.kind !== 'claimable_node') return;
    await expect(
      exhaustedLifecycle.claim({
        candidate: exhaustedCandidate,
        generatedAttemptId: 'attempt-exhausted',
        generatedDispatchIdempotencyKey: 'dispatch-exhausted',
        idempotencyKey: 'claim-exhausted',
        leasePolicy,
        managerIncarnationId: 'manager-exhausted',
        ownerLabel: 'exhausted manager',
        planDocument: planWithMaximumAttempts(1),
      }),
    ).resolves.toMatchObject({
      conflict: { code: 'INVALID_STATE' },
      kind: 'conflict',
    });
  });

  it('rejects a globally colliding generated Attempt id without durable artifacts', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      attempts: [
        attemptFixture({
          id: 'attempt-collision',
          nodeInstanceId: 'other-node',
          runId: 'other-run',
          status: 'succeeded',
        }),
      ],
      nodes: [nodeFixture()],
      runs: [runFixture()],
    });
    const lifecycle = createRunLifecycle({ store });
    const discovery = await lifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    if (candidate?.kind !== 'claimable_node') return;

    await expect(
      lifecycle.claim({
        candidate,
        generatedAttemptId: 'attempt-collision',
        generatedDispatchIdempotencyKey: 'dispatch-collision',
        idempotencyKey: 'claim-collision',
        leasePolicy,
        managerIncarnationId: 'manager-collision',
        ownerLabel: 'collision manager',
        planDocument,
      }),
    ).resolves.toMatchObject({
      conflict: { code: 'REVISION_CONFLICT' },
      kind: 'conflict',
    });
    await store.transaction(async (transaction) => {
      await expect(transaction.getNode(candidate.node.nodeInstanceId)).resolves.toMatchObject({
        kind: 'found',
        value: { activeAttemptId: null, revision: candidate.node.nodeRevision },
      });
      await expect(
        transaction.getIdempotency({
          key: 'claim-collision',
          operation: 'claim_attempt',
          runId: candidate.run.runId,
          subjectId: candidate.node.nodeInstanceId,
        }),
      ).resolves.toEqual({ kind: 'not_found' });
    });
    await expect(
      store.readEvents({
        limit: 10,
        runId: candidate.run.runId,
        scan: { after: { runId: candidate.run.runId, sequence: 0 }, kind: 'start' },
      }),
    ).resolves.toMatchObject({ kind: 'page', page: { items: [] } });
  });

  it.each(['claim', 'acquire'] as const)(
    'maps %s database-time lease overflow to fixed invalid input with atomic rollback',
    async (operation) => {
      const transactionNow = Number.MAX_SAFE_INTEGER - 1_000;
      const store = new LogicalRunStoreFake(transactionNow);
      const run = runFixture();
      const node =
        operation === 'claim' ? nodeFixture() : executingNodeFixture('executing', { revision: 1 });
      const attempt = attemptFixture({ leaseExpiresAt: transactionNow - 1 });
      store.seed({
        attempts: operation === 'acquire' ? [attempt] : [],
        nodes: [node],
        runs: [run],
      });
      const lifecycle = createRunLifecycle({ store });
      const discovery = await lifecycle.discover({
        kinds: operation === 'claim' ? ['claimable_node'] : ['expired_attempt'],
        limit: 1,
        renewal: null,
        scan: { kind: 'start' },
      });
      if (discovery.kind !== 'page') return;
      const candidate = discovery.page.items[0];
      let result;
      if (operation === 'claim' && candidate?.kind === 'claimable_node') {
        result = await lifecycle.claim({
          candidate,
          generatedAttemptId: 'overflow-attempt',
          generatedDispatchIdempotencyKey: 'overflow-dispatch',
          idempotencyKey: 'overflow-claim',
          leasePolicy,
          managerIncarnationId: 'overflow-manager',
          ownerLabel: 'overflow manager',
          planDocument,
        });
      } else if (operation === 'acquire' && candidate?.kind === 'expired_attempt') {
        result = await lifecycle.acquire({
          candidate,
          idempotencyKey: 'overflow-acquire',
          leasePolicy,
          successorManagerIncarnationId: 'overflow-successor',
        });
      } else {
        throw new Error(`Expected ${operation} candidate.`);
      }
      expect(result).toEqual(invalidResult);
      await store.transaction(async (transaction) => {
        await expect(transaction.getNode(node.id)).resolves.toMatchObject({
          kind: 'found',
          value: {
            activeAttemptId: operation === 'claim' ? null : attempt.id,
            revision: node.revision,
          },
        });
        await expect(
          transaction.getIdempotency({
            key: `overflow-${operation}`,
            operation: operation === 'claim' ? 'claim_attempt' : 'acquire_attempt',
            runId: run.id,
            subjectId: operation === 'claim' ? node.id : attempt.id,
          }),
        ).resolves.toEqual({ kind: 'not_found' });
      });
    },
  );

  it('propagates claim provider rejection and rolls back lifecycle artifacts', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const node = nodeFixture();
    store.seed({ nodes: [node], runs: [runFixture()] });
    const lifecycle = createRunLifecycle({ store });
    const discovery = await lifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    if (candidate?.kind !== 'claimable_node') return;
    store.failAfterNextStage('attempts');
    await expect(
      lifecycle.claim({
        candidate,
        generatedAttemptId: 'rejected-attempt',
        generatedDispatchIdempotencyKey: 'rejected-dispatch',
        idempotencyKey: 'rejected-claim',
        leasePolicy,
        managerIncarnationId: 'rejected-manager',
        ownerLabel: 'rejected manager',
        planDocument,
      }),
    ).rejects.toThrow('after attempts');
    await store.transaction(async (transaction) => {
      await expect(transaction.getAttempt('rejected-attempt')).resolves.toEqual({
        kind: 'not_found',
      });
      await expect(transaction.getNode(node.id)).resolves.toMatchObject({
        kind: 'found',
        value: { activeAttemptId: null, revision: node.revision },
      });
    });
  });

  it('propagates handoff and acquisition provider rejections without partial authority', async () => {
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const attempt = attemptFixture({ executorConfigurationDigest: configurationDigest });
    const handoffStore = new LogicalRunStoreFake(1_500);
    handoffStore.seed({ attempts: [attempt], nodes: [node], runs: [run] });
    handoffStore.failAfterNextStage('handoff');
    await expect(
      createRunLifecycle({ store: handoffStore }).writeHandoff({
        authority: authorityValue,
        generatedHandoffId: 'rejected-handoff',
        idempotencyKey: 'rejected-handoff-key',
        reason: 'manager_shutdown',
      }),
    ).rejects.toThrow('after handoff');
    await handoffStore.transaction(async (transaction) => {
      await expect(
        transaction.getHandoff({ attemptId: attempt.id, incumbentFencingToken: 1 }),
      ).resolves.toEqual({ kind: 'not_found' });
      await expect(transaction.getAttempt(attempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { fencingToken: 1, managerIncarnationId: 'manager-1', revision: 0 },
      });
    });

    const acquisitionStore = new LogicalRunStoreFake(3_000);
    acquisitionStore.seed({
      attempts: [attemptFixture({ leaseExpiresAt: 2_900 })],
      nodes: [node],
      runs: [run],
    });
    const lifecycle = createRunLifecycle({ store: acquisitionStore });
    const discovery = await lifecycle.discover({
      kinds: ['expired_attempt'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    if (candidate?.kind !== 'expired_attempt') return;
    acquisitionStore.failAfterNextStage('attempts');
    await expect(
      lifecycle.acquire({
        candidate,
        idempotencyKey: 'rejected-acquire',
        leasePolicy,
        successorManagerIncarnationId: 'rejected-successor',
      }),
    ).rejects.toThrow('after attempts');
    await acquisitionStore.transaction(async (transaction) => {
      await expect(transaction.getAttempt(attempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { fencingToken: 1, managerIncarnationId: 'manager-1', revision: 0 },
      });
      await expect(
        transaction.getIdempotency({
          key: 'rejected-acquire',
          operation: 'acquire_attempt',
          runId: run.id,
          subjectId: attempt.id,
        }),
      ).resolves.toEqual({ kind: 'not_found' });
    });
  });

  it('fails closed on malformed stored claim, handoff, and acquisition replays', async () => {
    const claimIdentity = {
      key: 'replay-claim',
      operation: 'claim_attempt' as const,
      runId: 'run-1',
      subjectId: 'node-1',
    };
    const claimStore = new LogicalRunStoreFake(1_500);
    claimStore.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    const claimLifecycle = createRunLifecycle({ store: claimStore });
    const claimDiscovery = await claimLifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (claimDiscovery.kind !== 'page') return;
    const claimCandidate = claimDiscovery.page.items[0];
    if (claimCandidate?.kind !== 'claimable_node') return;
    const claimRequest = {
      candidate: claimCandidate,
      generatedAttemptId: 'replay-attempt',
      generatedDispatchIdempotencyKey: 'replay-dispatch',
      idempotencyKey: claimIdentity.key,
      leasePolicy,
      managerIncarnationId: 'replay-manager',
      ownerLabel: 'replay manager',
      planDocument,
    };
    await claimLifecycle.claim(claimRequest);
    const claimRecord = await readIdempotency(claimStore, claimIdentity);
    const malformedClaims = [
      structuredClone(claimRecord),
      structuredClone(claimRecord),
      structuredClone(claimRecord),
      structuredClone(claimRecord),
      structuredClone(claimRecord),
      structuredClone(claimRecord),
    ];
    Reflect.deleteProperty(malformedClaims[0]!.identity, 'operation');
    setJsonMember(malformedClaims[1]!.result, 'attemptPhase', 'unknown');
    setJsonMember(malformedClaims[2]!.result, 'attemptId', 'other-attempt');
    Reflect.set(malformedClaims[3]!, 'request', undefined);
    if (malformedClaims[4]!.result !== null && typeof malformedClaims[4]!.result === 'object') {
      Reflect.set(malformedClaims[4]!.result, 'attemptId', 17);
    }
    if (malformedClaims[5]!.result !== null && typeof malformedClaims[5]!.result === 'object') {
      Reflect.set(malformedClaims[5]!.result, 'ordinal', 'zero');
    }
    await Promise.all(
      malformedClaims.map(async (record) => {
        const store = new LogicalRunStoreFake(1_500);
        store.seed({
          idempotency: [{ lookup: claimIdentity, record }],
          nodes: [nodeFixture()],
          runs: [runFixture()],
        });
        await expect(createRunLifecycle({ store }).claim(claimRequest)).resolves.toEqual(
          invalidResult,
        );
        await store.transaction(async (transaction) => {
          await expect(transaction.getAttempt('replay-attempt')).resolves.toEqual({
            kind: 'not_found',
          });
        });
      }),
    );

    const handoffIdentity = {
      key: 'replay-handoff',
      operation: 'write_handoff' as const,
      runId: 'run-1',
      subjectId: 'attempt-1',
    };
    const handoffRequest = {
      authority: authorityValue,
      generatedHandoffId: 'replay-handoff-id',
      idempotencyKey: handoffIdentity.key,
      reason: 'manager_shutdown' as const,
    };
    const handoffSource = new LogicalRunStoreFake(1_500);
    handoffSource.seed({
      attempts: [attemptFixture({ executorConfigurationDigest: configurationDigest })],
      nodes: [executingNodeFixture('executing', { revision: 1 })],
      runs: [runFixture()],
    });
    await createRunLifecycle({ store: handoffSource }).writeHandoff(handoffRequest);
    const handoffRecord = await readIdempotency(handoffSource, handoffIdentity);
    const malformedHandoffs = [structuredClone(handoffRecord), structuredClone(handoffRecord)];
    setJsonMember(malformedHandoffs[0]!.result, 'handoffId', 'wrong-handoff');
    Reflect.set(malformedHandoffs[1]!, 'request', undefined);
    await Promise.all(
      malformedHandoffs.map(async (record) => {
        const handoffReplayStore = new LogicalRunStoreFake(1_500);
        handoffReplayStore.seed({
          idempotency: [{ lookup: handoffIdentity, record }],
        });
        await expect(
          createRunLifecycle({ store: handoffReplayStore }).writeHandoff(handoffRequest),
        ).resolves.toEqual(invalidResult);
      }),
    );
    const mismatchedHandoff = structuredClone(handoffRecord);
    if (mismatchedHandoff.request !== null && typeof mismatchedHandoff.request === 'object') {
      Reflect.set(mismatchedHandoff.request, 'reason', 'operator_request');
    }
    const invalidHandoffRequest = structuredClone(handoffRecord);
    Reflect.set(invalidHandoffRequest, 'request', undefined);
    const invalidHandoffRecord = structuredClone(handoffRecord);
    Reflect.deleteProperty(invalidHandoffRecord.identity, 'operation');
    let handoffGetterCalls = 0;
    const hostileHandoffRequest = structuredClone(handoffRecord);
    Object.defineProperty(hostileHandoffRequest, 'request', {
      enumerable: true,
      get: () => {
        handoffGetterCalls += 1;
        return handoffRecord.request;
      },
    });
    await Promise.all(
      (
        [
          [handoffRecord, { kind: 'replayed' }],
          [mismatchedHandoff, { conflict: { code: 'IDEMPOTENCY_CONFLICT' }, kind: 'conflict' }],
          [invalidHandoffRequest, invalidResult],
          [invalidHandoffRecord, invalidResult],
          [hostileHandoffRequest, invalidResult],
        ] as const
      ).map(async ([record, expected]) => {
        const base = new LogicalRunStoreFake(1_500);
        base.seed({
          attempts: [attemptFixture({ executorConfigurationDigest: configurationDigest })],
          nodes: [executingNodeFixture('executing', { revision: 1 })],
          runs: [runFixture()],
        });
        await expect(
          createRunLifecycle({
            store: withInjectedCommitResult(base, { kind: 'replayed', record }),
          }).writeHandoff(handoffRequest),
        ).resolves.toMatchObject(expected);
        await expect(
          base.transaction((transaction) =>
            transaction.getHandoff({ attemptId: 'attempt-1', incumbentFencingToken: 1 }),
          ),
        ).resolves.toEqual({ kind: 'not_found' });
      }),
    );
    expect(handoffGetterCalls).toBe(0);

    const acquireIdentity = {
      key: 'replay-acquire',
      operation: 'acquire_attempt' as const,
      runId: 'run-1',
      subjectId: 'attempt-1',
    };
    const incumbentAttempt = attemptFixture({ leaseExpiresAt: 2_900 });
    const incumbentNode = executingNodeFixture('executing', { revision: 1 });
    const acquireSource = new LogicalRunStoreFake(3_000);
    acquireSource.seed({
      attempts: [incumbentAttempt],
      nodes: [incumbentNode],
      runs: [runFixture()],
    });
    const acquireLifecycle = createRunLifecycle({ store: acquireSource });
    const acquireDiscovery = await acquireLifecycle.discover({
      kinds: ['expired_attempt'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (acquireDiscovery.kind !== 'page') return;
    const acquireCandidate = acquireDiscovery.page.items[0];
    if (acquireCandidate?.kind !== 'expired_attempt') return;
    const acquireRequest = {
      candidate: acquireCandidate,
      idempotencyKey: acquireIdentity.key,
      leasePolicy,
      successorManagerIncarnationId: 'replay-successor',
    };
    await acquireLifecycle.acquire(acquireRequest);
    const acquireRecord = await readIdempotency(acquireSource, acquireIdentity);
    const malformedAcquires = [
      structuredClone(acquireRecord),
      structuredClone(acquireRecord),
      structuredClone(acquireRecord),
    ];
    setJsonMember(malformedAcquires[0]!.result, 'recovery', 'execute');
    Reflect.set(malformedAcquires[1]!, 'committedAt', Number.MAX_SAFE_INTEGER + 1);
    Reflect.set(malformedAcquires[2]!, 'request', undefined);
    await Promise.all(
      malformedAcquires.map(async (record) => {
        const store = new LogicalRunStoreFake(3_000);
        store.seed({
          attempts: [incumbentAttempt],
          idempotency: [{ lookup: acquireIdentity, record }],
          nodes: [incumbentNode],
          runs: [runFixture()],
        });
        await expect(createRunLifecycle({ store }).acquire(acquireRequest)).resolves.toEqual(
          invalidResult,
        );
        await store.transaction(async (transaction) => {
          await expect(transaction.getAttempt(incumbentAttempt.id)).resolves.toMatchObject({
            kind: 'found',
            value: { fencingToken: 1, managerIncarnationId: 'manager-1', revision: 0 },
          });
        });
      }),
    );
    const mismatchedAcquire = structuredClone(acquireRecord);
    if (mismatchedAcquire.request !== null && typeof mismatchedAcquire.request === 'object') {
      Reflect.set(mismatchedAcquire.request, 'successorManagerIncarnationId', 'other-successor');
    }
    const invalidAcquireRequest = structuredClone(acquireRecord);
    Reflect.set(invalidAcquireRequest, 'request', undefined);
    const invalidAcquireRecord = structuredClone(acquireRecord);
    setJsonMember(invalidAcquireRecord.result, 'recovery', 'execute');
    let acquireGetterCalls = 0;
    const hostileAcquireRequest = structuredClone(acquireRecord);
    Object.defineProperty(hostileAcquireRequest, 'request', {
      enumerable: true,
      get: () => {
        acquireGetterCalls += 1;
        return acquireRecord.request;
      },
    });
    await Promise.all(
      (
        [
          [acquireRecord, { kind: 'replayed' }],
          [mismatchedAcquire, { conflict: { code: 'IDEMPOTENCY_CONFLICT' }, kind: 'conflict' }],
          [invalidAcquireRequest, invalidResult],
          [invalidAcquireRecord, invalidResult],
          [hostileAcquireRequest, invalidResult],
        ] as const
      ).map(async ([record, expected]) => {
        const base = new LogicalRunStoreFake(3_000);
        base.seed({
          attempts: [incumbentAttempt],
          nodes: [incumbentNode],
          runs: [runFixture()],
        });
        await expect(
          createRunLifecycle({
            store: withInjectedCommitResult(base, { kind: 'replayed', record }),
          }).acquire(acquireRequest),
        ).resolves.toMatchObject(expected);
        await expect(
          base.transaction((transaction) => transaction.getAttempt(incumbentAttempt.id)),
        ).resolves.toMatchObject({
          kind: 'found',
          value: { fencingToken: 1, managerIncarnationId: 'manager-1', revision: 0 },
        });
      }),
    );
    expect(acquireGetterCalls).toBe(0);
  });

  it('separates malformed plan snapshots from post-snapshot plan mismatches', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    const lifecycle = createRunLifecycle({ store });
    const discovery = await lifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    if (candidate?.kind !== 'claimable_node') return;
    const request = {
      candidate,
      generatedAttemptId: 'attempt-plan-test',
      generatedDispatchIdempotencyKey: 'dispatch-plan-test',
      idempotencyKey: 'claim-plan-test',
      leasePolicy,
      managerIncarnationId: 'manager-plan-test',
      ownerLabel: 'plan test manager',
      planDocument,
    };

    await expect(
      lifecycle.claim({
        ...request,
        planDocument: {
          ...planDocument,
          executorBindings: [planBinding, planBinding],
        },
      }),
    ).resolves.toEqual({
      fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
      kind: 'fault',
    });
    await expect(
      lifecycle.claim({
        ...request,
        planDocument: { ...planDocument, executorBindings: [] },
      }),
    ).resolves.toMatchObject({
      fault: { code: 'PLAN_MISMATCH' },
      kind: 'fault',
    });
    await expect(
      lifecycle.claim({
        ...request,
        planDocument: {
          ...planDocument,
          pin: { ...planPin, revision: 'different' },
        },
      }),
    ).resolves.toMatchObject({
      fault: { code: 'PLAN_MISMATCH' },
      kind: 'fault',
    });
  });

  it('rejects accessor-backed and extra-key lifecycle requests without invoking hostile code', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({ nodes: [nodeFixture()], runs: [runFixture()] });
    const lifecycle = createRunLifecycle({ store });
    const discovery = await lifecycle.discover({
      kinds: ['claimable_node'],
      limit: 1,
      renewal: null,
      scan: { kind: 'start' },
    });
    if (discovery.kind !== 'page') return;
    const candidate = discovery.page.items[0];
    if (candidate?.kind !== 'claimable_node') return;
    let calls = 0;
    const hostile = Object.defineProperty(
      {
        candidate,
        generatedAttemptId: 'attempt-hostile',
        generatedDispatchIdempotencyKey: 'dispatch-hostile',
        idempotencyKey: 'claim-hostile',
        leasePolicy,
        managerIncarnationId: 'manager-hostile',
        ownerLabel: 'hostile manager',
        planDocument,
      },
      'candidate',
      {
        enumerable: true,
        get: () => {
          calls += 1;
          return candidate;
        },
      },
    );
    await expect(lifecycle.claim(hostile)).resolves.toEqual({
      fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
      kind: 'fault',
    });
    expect(calls).toBe(0);

    const extra = {
      kinds: ['claimable_node'] as const,
      limit: 1,
      renewal: null,
      scan: { kind: 'start' as const },
      unexpected: true,
    };
    await expect(lifecycle.discover(extra)).resolves.toEqual({
      fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
      kind: 'fault',
    });
  });

  it('rejects malformed exact-key authority, phase, digest, cursor, and acquisition shapes', async () => {
    const lifecycle = createRunLifecycle({
      store: new LogicalRunStoreFake(1_500),
    });
    await expect(
      lifecycle.renewLease({
        authority: Object.defineProperty({ ...authorityValue }, 'unexpected', {
          enumerable: true,
          value: true,
        }),
        leasePolicy,
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.writeHandoff({
        authority: Object.defineProperty({ ...authorityValue }, 'executorConfigurationDigest', {
          enumerable: true,
          value: 'invalid',
        }),
        generatedHandoffId: 'handoff',
        idempotencyKey: 'handoff-key',
        reason: 'manager_shutdown',
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.acquire({
        candidate: {
          ...expiredCandidate,
          attempt: Object.defineProperty({ ...expiredCandidate.attempt }, 'attemptPhase', {
            enumerable: true,
            value: 'succeeded',
          }),
        },
        idempotencyKey: 'acquire-key',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.discover({
        kinds: ['claimable_node'],
        limit: 1,
        renewal: null,
        scan: {
          cursor: {
            highWatermark: 1_500,
            kinds: ['claimable_node'],
            last: {
              attemptId: null,
              eligibleAt: -1,
              kind: 'claimable_node',
              nodeInstanceId: 'node-1',
              runId: 'run-1',
            },
            renewal: null,
          },
          kind: 'continue',
        },
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.renewLease({
        authority: Object.defineProperty({ ...authorityValue }, 'attemptPhase', {
          enumerable: true,
          value: 'succeeded',
        }),
        leasePolicy,
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.renewLease({
        authority: Object.defineProperty({ ...authorityValue }, 'nodePhase', {
          enumerable: true,
          value: 'ready',
        }),
        leasePolicy,
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.acquire({
        candidate: Object.defineProperty({ ...expiredCandidate }, 'handoffId', {
          enumerable: true,
          value: 'unexpected',
        }),
        idempotencyKey: 'acquire-key',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.discover(
        Object.defineProperty(
          {
            kinds: ['claimable_node'],
            limit: 1,
            renewal: null,
            scan: { kind: 'start' as const },
          },
          'scan',
          { enumerable: true, value: null },
        ),
      ),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.acquire({
        candidate: Object.defineProperty({ ...expiredCandidate }, 'kind', {
          enumerable: true,
          value: 'cancellation_run',
        }),
        idempotencyKey: 'acquire-key',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.acquire({
        candidate: {
          ...expiredCandidate,
          node: { ...expiredCandidate.node, activeAttemptId: 'different-attempt' },
        },
        idempotencyKey: 'acquire-key',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.discover({
        kinds: ['renewable_attempt'],
        limit: 1,
        renewal: Object.defineProperty(
          { leasePolicy, managerIncarnationId: 'manager-1' },
          'managerIncarnationId',
          { enumerable: true, value: '' },
        ),
        scan: { kind: 'start' },
      }),
    ).resolves.toEqual(invalidResult);
    const cancellationCandidate = Object.defineProperties(
      { ...expiredCandidate },
      {
        attempt: { enumerable: true, value: null },
        handoffId: { enumerable: true, value: null },
        kind: { enumerable: true, value: 'cancellation_run' },
        node: { enumerable: true, value: null },
      },
    );
    await expect(
      lifecycle.acquire({
        candidate: cancellationCandidate,
        idempotencyKey: 'acquire-key',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toEqual(invalidResult);
    const claimableCandidate = Object.defineProperties(
      { ...expiredCandidate },
      {
        attempt: { enumerable: true, value: null },
        handoffId: { enumerable: true, value: null },
        kind: { enumerable: true, value: 'claimable_node' },
        node: {
          enumerable: true,
          value: { ...expiredCandidate.node, activeAttemptId: null },
        },
      },
    );
    await expect(
      lifecycle.acquire({
        candidate: claimableCandidate,
        idempotencyKey: 'acquire-key',
        leasePolicy,
        successorManagerIncarnationId: 'manager-2',
      }),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.writeHandoff(
        Object.defineProperty(
          {
            authority: authorityValue,
            generatedHandoffId: 'handoff',
            idempotencyKey: 'handoff-key',
            reason: 'manager_shutdown' as const,
          },
          'reason',
          { enumerable: true, value: 'invalid-reason' },
        ),
      ),
    ).resolves.toEqual(invalidResult);
    await expect(
      lifecycle.discover(
        Object.defineProperty(
          {
            kinds: ['claimable_node'] as const,
            limit: 1,
            renewal: null,
            scan: { kind: 'start' as const },
          },
          'kinds',
          { enumerable: true, value: ['invalid-kind'] },
        ),
      ),
    ).resolves.toEqual(invalidResult);
  });
});
