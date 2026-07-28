import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ExecutorFailureFaultCode } from '../../src/errors/index.js';
import { createRunLifecycle } from '../../src/lifecycle/construction.js';
import type {
  LifecycleAttemptAuthority,
  LifecycleExecuteObservation,
  LifecyclePrepareReconciliationResult,
  LifecycleProgressionObservation,
  LifecycleReconcilingExecutionAuthority,
  LifecycleStartedExecutionAuthority,
  LifecycleUnknownExecutionAuthority,
} from '../../src/lifecycle/index.js';
import { snapshotExecutorConfiguration } from '../../src/policy/index.js';
import type { RunStore } from '../../src/storage/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  attemptFixture,
  executingNodeFixture,
  planPin,
  runFixture,
} from '../support/store-fixtures.js';

const configuration = { model: 'stable' };
const configurationDigest = snapshotExecutorConfiguration(configuration).digest;
const executorPin = { adapterId: 'executor', digest: 'executor-digest', revision: '1' };
const binding = {
  configuration,
  configurationDigest,
  executor: executorPin,
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
  executorBindings: [binding],
  pin: planPin,
  terminalBindings: [],
};

type Revisions = { readonly attempt: number; readonly node: number; readonly run: number };

function authority(
  attemptPhase: 'start_committed',
  nodePhase: 'executing',
  revisions: Revisions,
): LifecycleStartedExecutionAuthority;
function authority(
  attemptPhase: 'unknown',
  nodePhase: 'unknown',
  revisions: Revisions,
): LifecycleUnknownExecutionAuthority;
function authority(
  attemptPhase: 'reconciling',
  nodePhase: 'unknown',
  revisions: Revisions,
): LifecycleReconcilingExecutionAuthority;
function authority(
  attemptPhase: LifecycleAttemptAuthority['attemptPhase'],
  nodePhase: LifecycleAttemptAuthority['nodePhase'],
  revisions: { readonly attempt: number; readonly node: number; readonly run: number },
): LifecycleAttemptAuthority {
  return {
    activationId: 'activation-1',
    attemptId: 'attempt-1',
    attemptPhase,
    dispatchIdempotencyKey: 'dispatch-1',
    executorConfigurationDigest: configurationDigest,
    executorContractPin: executorPin,
    expectedAttemptRevision: revisions.attempt,
    expectedNodeRevision: revisions.node,
    expectedRunRevision: revisions.run,
    fencingToken: 1,
    leaseExpiresAt: 3_000,
    managerIncarnationId: 'manager-1',
    nodeInstanceId: 'node-1',
    nodeKey: 'node',
    nodePhase,
    planPin,
    runId: 'run-1',
  };
}

const storeWithCommitCount = (store: LogicalRunStoreFake) => {
  let commits = 0;
  const wrapped: RunStore = {
    discover: (query) => store.discover(query),
    getRun: (runId) => store.getRun(runId),
    listRuns: (query) => store.listRuns(query),
    readEvents: (query) => store.readEvents(query),
    transaction: (callback) =>
      store.transaction((transaction) =>
        callback({
          ...transaction,
          commit: (command) => {
            commits += 1;
            return transaction.commit(command);
          },
        }),
      ),
  };
  return { commits: () => commits, store: wrapped };
};

const resolverReturning = (value: unknown) => {
  const resolver = {
    resolveExact: async () => ({ fault: unknownFault, kind: 'unavailable' as const }),
  };
  Object.defineProperty(resolver, 'resolveExact', {
    value: async () => value,
  });
  return resolver;
};

it('keeps lifecycle failure observations on the exact package-owned failure code set', () => {
  type ProgressionFailure = Extract<LifecycleProgressionObservation, { readonly kind: 'failed' }>;

  expectTypeOf<ProgressionFailure['fault']['code']>().toEqualTypeOf<ExecutorFailureFaultCode>();
  expectTypeOf<ProgressionFailure['fault']['code']>().toEqualTypeOf<
    | 'EXECUTOR_MISMATCH'
    | 'EXECUTOR_UNAVAILABLE'
    | 'INVALID_INPUT'
    | 'INVALID_STATE'
    | 'PLAN_MISMATCH'
    | 'PLAN_UNAVAILABLE'
    | 'REVISION_CONFLICT'
    | 'STALE_ACTIVATION'
    | 'STALE_FENCE'
  >();
  expectTypeOf<'CANCELLED'>().not.toMatchTypeOf<ProgressionFailure['fault']['code']>();
  expectTypeOf<'NOT_FOUND'>().not.toMatchTypeOf<ProgressionFailure['fault']['code']>();
  expectTypeOf<'UNKNOWN_OUTCOME'>().not.toMatchTypeOf<ProgressionFailure['fault']['code']>();
});

describe('lifecycle execution observation', () => {
  it('commits and replays a direct unknown observation under fresh authority', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 1,
          status: 'start_committed',
        }),
      ],
      nodes: [executingNodeFixture('executing', { revision: 1 })],
      runs: [runFixture()],
    });
    const lifecycle = createRunLifecycle({
      executors: { resolveExact: async () => ({ kind: 'unavailable', fault: unknownFault }) },
      store,
    });
    const observation: LifecycleExecuteObservation = {
      fault: { code: 'UNKNOWN_OUTCOME', message: 'Transport response was lost.' },
      kind: 'unknown',
    };
    const request = {
      authority: authority('start_committed', 'executing', { attempt: 1, node: 1, run: 0 }),
      generatedOutputIds: [],
      idempotencyKey: 'direct-outcome-1',
      observation,
    };

    await expect(lifecycle.processExecuteObservation(request)).resolves.toMatchObject({
      kind: 'committed',
      value: {
        authority: {
          attemptPhase: 'unknown',
          expectedAttemptRevision: 2,
          expectedNodeRevision: 2,
          expectedRunRevision: 1,
          nodePhase: 'unknown',
        },
        observation: 'unknown',
      },
    });
    await expect(lifecycle.processExecuteObservation(request)).resolves.toMatchObject({
      kind: 'replayed',
      value: { observation: 'unknown' },
    });
    await expect(
      lifecycle.processExecuteObservation({
        ...request,
        observation: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Different semantic observation.' },
          kind: 'unknown',
        },
      }),
    ).resolves.toMatchObject({
      conflict: { code: 'IDEMPOTENCY_CONFLICT' },
      kind: 'conflict',
    });
  });

  it('prepares reconciliation only after fresh authority and invokes a captured receiver once', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 2,
          status: 'unknown',
        }),
      ],
      nodes: [executingNodeFixture('unknown', { revision: 2 })],
      runs: [runFixture({ revision: 1 })],
    });
    let calls = 0;
    let receiverMatches = false;
    let resolveCalls = 0;
    const executor = {
      contractPin: executorPin,
      execute: async () => ({ kind: 'cancelled' as const }),
      reconcile() {
        calls += 1;
        receiverMatches = this === executor;
        return Promise.resolve({ kind: 'running' as const });
      },
    };
    const lifecycle = createRunLifecycle({
      executors: {
        resolveExact: async () => {
          resolveCalls += 1;
          return { executor, kind: 'resolved' };
        },
      },
      store,
    });

    const prepared = await lifecycle.prepareReconciliation({
      authority: authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 }),
      beginIdempotencyKey: 'begin-reconcile-1',
      planDocument,
    });
    expect(prepared).toMatchObject({
      kind: 'committed',
      value: {
        authority: { attemptPhase: 'reconciling', expectedAttemptRevision: 3 },
        kind: 'reconcile',
      },
    });
    if (prepared.kind !== 'committed') return;
    const observation = await prepared.value.reconcile.invoke(new AbortController().signal);
    expect(observation).toEqual({ kind: 'running' });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(receiverMatches).toBe(true);
    await expect(prepared.value.reconcile.invoke(new AbortController().signal)).rejects.toThrow(
      'Prepared reconcile capability was already consumed.',
    );
    expect(calls).toBe(1);

    await expect(
      lifecycle.prepareReconciliation({
        authority: authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 }),
        beginIdempotencyKey: 'begin-reconcile-1',
        planDocument,
      }),
    ).resolves.toMatchObject({
      kind: 'replayed',
      value: { attemptRevision: 3 },
    });
    expect(resolveCalls).toBe(1);

    await expect(
      lifecycle.processReconcileObservation({
        authority: prepared.value.authority,
        generatedOutputIds: [],
        idempotencyKey: 'reconcile-outcome-1',
        observation,
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      value: {
        authority: {
          attemptPhase: 'start_committed',
          expectedAttemptRevision: 4,
          expectedNodeRevision: 3,
          expectedRunRevision: 2,
          nodePhase: 'executing',
        },
        observation: 'running',
      },
    });
    await expect(
      store.transaction((transaction) =>
        Promise.all([
          transaction.getIdempotency({
            key: 'begin-reconcile-1',
            operation: 'begin_reconciliation',
            runId: 'run-1',
            subjectId: 'attempt-1',
          }),
          transaction.getIdempotency({
            key: 'reconcile-outcome-1',
            operation: 'reconciled_running',
            runId: 'run-1',
            subjectId: 'attempt-1',
          }),
        ]),
      ),
    ).resolves.toMatchObject([{ kind: 'found' }, { kind: 'found' }]);
  });

  it('returns known observations for progression without a Store commit', async () => {
    const base = new LogicalRunStoreFake(1_500);
    base.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 1,
          status: 'start_committed',
        }),
      ],
      nodes: [executingNodeFixture('executing', { revision: 1 })],
      runs: [runFixture()],
    });
    const counted = storeWithCommitCount(base);
    const lifecycle = createRunLifecycle({
      executors: { resolveExact: async () => ({ kind: 'unavailable', fault: unknownFault }) },
      store: counted.store,
    });
    const observation: LifecycleExecuteObservation = {
      kind: 'succeeded',
      outputs: [{ name: 'result', payload: { kind: 'json', value: { ok: true } } }],
    };

    const result = await lifecycle.processExecuteObservation({
      authority: authority('start_committed', 'executing', { attempt: 1, node: 1, run: 0 }),
      generatedOutputIds: ['output-1'],
      idempotencyKey: 'unused-for-known',
      observation,
    });
    expect(result).toMatchObject({
      kind: 'requires_progression',
      observation: {
        kind: 'succeeded',
        outputs: [{ name: 'result', outputId: 'output-1' }],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(counted.commits()).toBe(0);
    await expect(
      base.transaction((transaction) =>
        transaction.getIdempotency({
          key: 'unused-for-known',
          operation: 'direct_success',
          runId: 'run-1',
          subjectId: 'attempt-1',
        }),
      ),
    ).resolves.toEqual({ kind: 'not_found' });
    await expect(
      base.transaction((transaction) =>
        transaction.getIdempotency({
          key: 'begin-reconcile-absent',
          operation: 'begin_reconciliation',
          runId: 'run-1',
          subjectId: 'attempt-1',
        }),
      ),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('normalizes rejected and hostile execute results to bounded unknown observations', async () => {
    const values = [
      {
        execute: async () => {
          throw new Error('provider stack and secret detail');
        },
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
          kind: 'unknown',
        },
        expectedGetterCalls: 0,
      },
      (() => {
        let getterCalls = 0;
        const hostile = Object.defineProperty({}, 'kind', {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 'cancelled';
          },
        });
        return {
          execute: async () => hostile,
          expected: {
            fault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
            kind: 'unknown',
          },
          expectedGetterCalls: () => getterCalls,
        };
      })(),
      {
        execute: async () => ({ extra: true, kind: 'cancelled' }),
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
          kind: 'unknown',
        },
        expectedGetterCalls: 0,
      },
      {
        execute: async () => ({
          fault: { code: 'INVALID_STATE', message: 'Executor rejected the request.' },
          kind: 'failed',
        }),
        expected: {
          fault: { code: 'INVALID_STATE', message: 'Executor rejected the request.' },
          kind: 'failed',
        },
        expectedGetterCalls: 0,
      },
      {
        execute: async () => ({
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Still uncertain.' },
          kind: 'unknown',
        }),
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Still uncertain.' },
          kind: 'unknown',
        },
        expectedGetterCalls: 0,
      },
      {
        execute: async () => ({ kind: 'cancelled' }),
        expected: { kind: 'cancelled' },
        expectedGetterCalls: 0,
      },
      {
        execute: async () => [],
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
          kind: 'unknown',
        },
        expectedGetterCalls: 0,
      },
      {
        execute: async () => ({
          fault: { code: 'UNKNOWN_OUTCOME', message: '' },
          kind: 'unknown',
        }),
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
          kind: 'unknown',
        },
        expectedGetterCalls: 0,
      },
      {
        execute: async () => ({
          fault: { code: 'INVALID_STATE', message: 'bad\u0000message' },
          kind: 'failed',
        }),
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
          kind: 'unknown',
        },
        expectedGetterCalls: 0,
      },
    ];

    await Promise.all(
      values.map(async (value, index) => {
        const store = new LogicalRunStoreFake(1_500);
        store.seed({
          attempts: [attemptFixture({ executorConfigurationDigest: configurationDigest })],
          nodes: [executingNodeFixture('executing', { revision: 1 })],
          runs: [runFixture()],
        });
        const lifecycle = createRunLifecycle({
          executors: resolverReturning({
            executor: {
              contractPin: executorPin,
              execute: value.execute,
            },
            kind: 'resolved',
          }),
          store,
        });
        const started = await lifecycle.verifyAndStart({
          authority: {
            ...authority('start_committed', 'executing', { attempt: 0, node: 1, run: 0 }),
            attemptPhase: 'claimed',
          },
          planDocument,
        });
        expect(started.kind, `case ${index}`).toBe('committed');
        if (started.kind !== 'committed') return;
        const observation = await started.value.execute.invoke(new AbortController().signal);
        expect(observation).toEqual(value.expected);
        expect(Object.isFrozen(observation)).toBe(true);
        const expected =
          typeof value.expectedGetterCalls === 'function'
            ? value.expectedGetterCalls()
            : value.expectedGetterCalls;
        expect(expected).toBe(0);
      }),
    );
  });

  it('copies and deeply freezes valid successful execute observations', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      attempts: [attemptFixture({ executorConfigurationDigest: configurationDigest })],
      nodes: [executingNodeFixture('executing', { revision: 1 })],
      runs: [runFixture()],
    });
    const raw = {
      kind: 'succeeded' as const,
      outputs: [
        {
          name: 'result',
          payload: { kind: 'json' as const, value: { nested: ['original'] } },
        },
      ],
    };
    const lifecycle = createRunLifecycle({
      executors: {
        resolveExact: async () => ({
          executor: {
            contractPin: executorPin,
            execute: async () => raw,
          },
          kind: 'resolved',
        }),
      },
      store,
    });
    const started = await lifecycle.verifyAndStart({
      authority: {
        ...authority('start_committed', 'executing', { attempt: 0, node: 1, run: 0 }),
        attemptPhase: 'claimed',
      },
      planDocument,
    });
    if (started.kind !== 'committed') throw new Error('Expected Start to commit.');
    const observation = await started.value.execute.invoke(new AbortController().signal);
    raw.outputs[0]!.name = 'mutated';
    raw.outputs[0]!.payload.value.nested[0] = 'mutated';
    expect(observation).toEqual({
      kind: 'succeeded',
      outputs: [
        {
          name: 'result',
          payload: { kind: 'json', value: { nested: ['original'] } },
        },
      ],
    });
    expect(Object.isFrozen(observation)).toBe(true);
    if (observation.kind !== 'succeeded') return;
    expect(Object.isFrozen(observation.outputs)).toBe(true);
    expect(Object.isFrozen(observation.outputs[0]?.payload)).toBe(true);
  });

  it.each([
    {
      expectedFault: { code: 'INVALID_STATE', message: 'é'.repeat(256) },
      expectedProcessKind: 'requires_progression',
      message: 'é'.repeat(256),
      name: 'exactly 512 UTF-8 bytes',
    },
    {
      expectedFault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
      expectedProcessKind: 'committed',
      message: `${'a'.repeat(511)}é`,
      name: '513 UTF-8 bytes',
    },
  ])(
    'enforces the execute fault-message boundary from capability through processing: $name',
    async ({ expectedFault, expectedProcessKind, message }) => {
      const store = new LogicalRunStoreFake(1_500);
      store.seed({
        attempts: [attemptFixture({ executorConfigurationDigest: configurationDigest })],
        nodes: [executingNodeFixture('executing', { revision: 1 })],
        runs: [runFixture()],
      });
      const lifecycle = createRunLifecycle({
        executors: resolverReturning({
          executor: {
            contractPin: executorPin,
            execute: async () => ({
              fault: { code: 'INVALID_STATE' as const, message },
              kind: 'failed' as const,
            }),
          },
          kind: 'resolved',
        }),
        store,
      });
      const started = await lifecycle.verifyAndStart({
        authority: {
          ...authority('start_committed', 'executing', { attempt: 0, node: 1, run: 0 }),
          attemptPhase: 'claimed',
        },
        planDocument,
      });
      expect(started.kind).toBe('committed');
      if (started.kind !== 'committed') return;
      const observation = await started.value.execute.invoke(new AbortController().signal);

      expect(observation).toMatchObject({ fault: expectedFault });
      await expect(
        lifecycle.processExecuteObservation({
          authority: started.value.authority,
          generatedOutputIds: [],
          idempotencyKey: `execute-message-${Buffer.byteLength(message, 'utf8')}`,
          observation,
        }),
      ).resolves.toMatchObject({ kind: expectedProcessKind });
    },
  );

  it('rejects output-id shape errors before any observation commit', async () => {
    const cases = [
      {
        generatedOutputIds: [],
        observation: {
          kind: 'succeeded' as const,
          outputs: [{ name: 'result', payload: { kind: 'json' as const, value: null } }],
        },
      },
      {
        generatedOutputIds: ['same', 'same'],
        observation: {
          kind: 'succeeded' as const,
          outputs: [
            { name: 'first', payload: { kind: 'json' as const, value: 1 } },
            { name: 'second', payload: { kind: 'json' as const, value: 2 } },
          ],
        },
      },
      {
        generatedOutputIds: ['unexpected'],
        observation: { kind: 'cancelled' as const },
      },
    ];
    await Promise.all(
      cases.map(async (value) => {
        const base = new LogicalRunStoreFake(1_500);
        base.seed({
          attempts: [
            attemptFixture({
              executorConfigurationDigest: configurationDigest,
              revision: 1,
              status: 'start_committed',
            }),
          ],
          nodes: [executingNodeFixture('executing', { revision: 1 })],
          runs: [runFixture()],
        });
        const counted = storeWithCommitCount(base);
        const lifecycle = createRunLifecycle({
          executors: { resolveExact: async () => ({ fault: unknownFault, kind: 'unavailable' }) },
          store: counted.store,
        });
        await expect(
          lifecycle.processExecuteObservation({
            authority: authority('start_committed', 'executing', {
              attempt: 1,
              node: 1,
              run: 0,
            }),
            generatedOutputIds: value.generatedOutputIds,
            idempotencyKey: 'shape-error',
            observation: value.observation,
          }),
        ).resolves.toMatchObject({ fault: { code: 'INVALID_INPUT' }, kind: 'fault' });
        expect(counted.commits()).toBe(0);
      }),
    );
  });

  it('rejects reconciliation and observations at the exact lease boundary', async () => {
    const unknownStore = new LogicalRunStoreFake(3_000);
    unknownStore.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 2,
          status: 'unknown',
        }),
      ],
      nodes: [executingNodeFixture('unknown', { revision: 2 })],
      runs: [runFixture({ revision: 1 })],
    });
    const unknownLifecycle = createRunLifecycle({
      executors: {
        resolveExact: async () => ({
          executor: {
            contractPin: executorPin,
            execute: async () => ({ kind: 'cancelled' as const }),
            reconcile: async () => ({ kind: 'running' as const }),
          },
          kind: 'resolved',
        }),
      },
      store: unknownStore,
    });
    await expect(
      unknownLifecycle.prepareReconciliation({
        authority: authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 }),
        beginIdempotencyKey: 'equality',
        planDocument,
      }),
    ).resolves.toMatchObject({ conflict: { code: 'STALE_FENCE' }, kind: 'conflict' });

    const startedStore = new LogicalRunStoreFake(3_000);
    startedStore.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 1,
          status: 'start_committed',
        }),
      ],
      nodes: [executingNodeFixture('executing', { revision: 1 })],
      runs: [runFixture()],
    });
    const startedLifecycle = createRunLifecycle({
      executors: { resolveExact: async () => ({ fault: unknownFault, kind: 'unavailable' }) },
      store: startedStore,
    });
    await expect(
      startedLifecycle.processExecuteObservation({
        authority: authority('start_committed', 'executing', { attempt: 1, node: 1, run: 0 }),
        generatedOutputIds: [],
        idempotencyKey: 'equality',
        observation: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'unknown' },
          kind: 'unknown',
        },
      }),
    ).resolves.toMatchObject({ conflict: { code: 'STALE_FENCE' }, kind: 'conflict' });
  });

  it('normalizes not-found, rejected, and malformed reconciliation observations', async () => {
    const cases = [
      {
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Reconciliation found no execution.' },
          kind: 'unknown',
        },
        reconcile: async () => ({ kind: 'not_found' as const }),
      },
      {
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Reconciliation outcome is unknown.' },
          kind: 'unknown',
        },
        reconcile: async () => {
          throw new Error('provider details');
        },
      },
      {
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Reconciliation outcome is unknown.' },
          kind: 'unknown',
        },
        reconcile: async () => ({ extra: true, kind: 'running' }),
      },
      {
        expected: { kind: 'running' },
        reconcile: async () => ({ kind: 'running' as const }),
      },
      {
        expected: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Still reconciling.' },
          kind: 'unknown',
        },
        reconcile: async () => ({
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Still reconciling.' },
          kind: 'unknown' as const,
        }),
      },
    ];
    await Promise.all(
      cases.map(async (value, index) => {
        const store = new LogicalRunStoreFake(1_500);
        store.seed({
          attempts: [
            attemptFixture({
              executorConfigurationDigest: configurationDigest,
              revision: 2,
              status: 'unknown',
            }),
          ],
          nodes: [executingNodeFixture('unknown', { revision: 2 })],
          runs: [runFixture({ revision: 1 })],
        });
        const lifecycle = createRunLifecycle({
          executors: resolverReturning({
            executor: {
              contractPin: executorPin,
              execute: async () => ({ kind: 'cancelled' }),
              reconcile: value.reconcile,
            },
            kind: 'resolved',
          }),
          store,
        });
        const prepared = await lifecycle.prepareReconciliation({
          authority: authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 }),
          beginIdempotencyKey: `normalize-reconcile-${index}`,
          planDocument,
        });
        expect(prepared.kind).toBe('committed');
        if (prepared.kind !== 'committed') return;
        await expect(
          prepared.value.reconcile.invoke(new AbortController().signal),
        ).resolves.toEqual(value.expected);
      }),
    );
  });

  it.each([
    {
      expectedFault: { code: 'INVALID_STATE', message: 'é'.repeat(256) },
      expectedProcessKind: 'requires_progression',
      message: 'é'.repeat(256),
      name: 'exactly 512 UTF-8 bytes',
    },
    {
      expectedFault: { code: 'UNKNOWN_OUTCOME', message: 'Reconciliation outcome is unknown.' },
      expectedProcessKind: 'committed',
      message: `${'a'.repeat(511)}é`,
      name: '513 UTF-8 bytes',
    },
  ])(
    'enforces the reconcile fault-message boundary from capability through processing: $name',
    async ({ expectedFault, expectedProcessKind, message }) => {
      const store = new LogicalRunStoreFake(1_500);
      store.seed({
        attempts: [
          attemptFixture({
            executorConfigurationDigest: configurationDigest,
            revision: 2,
            status: 'unknown',
          }),
        ],
        nodes: [executingNodeFixture('unknown', { revision: 2 })],
        runs: [runFixture({ revision: 1 })],
      });
      const lifecycle = createRunLifecycle({
        executors: resolverReturning({
          executor: {
            contractPin: executorPin,
            execute: async () => ({ kind: 'cancelled' }),
            reconcile: async () => ({
              fault: { code: 'INVALID_STATE' as const, message },
              kind: 'failed' as const,
            }),
          },
          kind: 'resolved',
        }),
        store,
      });
      const prepared = await lifecycle.prepareReconciliation({
        authority: authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 }),
        beginIdempotencyKey: `begin-message-${Buffer.byteLength(message, 'utf8')}`,
        planDocument,
      });
      expect(prepared.kind).toBe('committed');
      if (prepared.kind !== 'committed') return;
      const observation = await prepared.value.reconcile.invoke(new AbortController().signal);

      expect(observation).toMatchObject({ fault: expectedFault });
      await expect(
        lifecycle.processReconcileObservation({
          authority: prepared.value.authority,
          generatedOutputIds: [],
          idempotencyKey: `reconcile-message-${Buffer.byteLength(message, 'utf8')}`,
          observation,
        }),
      ).resolves.toMatchObject({ kind: expectedProcessKind });
    },
  );

  it('rejects accessor optional capabilities without invoking them or beginning reconciliation', async () => {
    const base = new LogicalRunStoreFake(1_500);
    base.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 2,
          status: 'unknown',
        }),
      ],
      nodes: [executingNodeFixture('unknown', { revision: 2 })],
      runs: [runFixture({ revision: 1 })],
    });
    const counted = storeWithCommitCount(base);
    let getterCalls = 0;
    const executor = {
      contractPin: executorPin,
      execute: async () => ({ kind: 'cancelled' as const }),
    };
    Object.defineProperty(executor, 'cancel', {
      get: () => {
        getterCalls += 1;
        return async () => ({ kind: 'cancelled' as const });
      },
    });
    Object.defineProperty(executor, 'reconcile', {
      value: async () => ({ kind: 'running' as const }),
    });
    const lifecycle = createRunLifecycle({
      executors: resolverReturning({ executor, kind: 'resolved' }),
      store: counted.store,
    });
    await expect(
      lifecycle.prepareReconciliation({
        authority: authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 }),
        beginIdempotencyKey: 'accessor-capability',
        planDocument,
      }),
    ).resolves.toMatchObject({
      fault: { code: 'EXECUTOR_UNAVAILABLE' },
      kind: 'fault',
    });
    expect(getterCalls).toBe(0);
    expect(counted.commits()).toBe(0);
  });

  it('rechecks authority after exact resolution and rejects a concurrent lease revision', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 2,
          status: 'unknown',
        }),
      ],
      nodes: [executingNodeFixture('unknown', { revision: 2 })],
      runs: [runFixture({ revision: 1 })],
    });
    const observed = authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 });
    let reconcileCalls = 0;
    const lifecycle = createRunLifecycle({
      executors: {
        resolveExact: async () => {
          await createRunLifecycle({
            executors: { resolveExact: async () => ({ fault: unknownFault, kind: 'unavailable' }) },
            store,
          }).renewLease({
            authority: observed,
            leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
          });
          return {
            executor: {
              contractPin: executorPin,
              execute: async () => ({ kind: 'cancelled' as const }),
              reconcile: async () => {
                reconcileCalls += 1;
                return { kind: 'running' as const };
              },
            },
            kind: 'resolved' as const,
          };
        },
      },
      store,
    });

    await expect(
      lifecycle.prepareReconciliation({
        authority: observed,
        beginIdempotencyKey: 'resolution-race',
        planDocument,
      }),
    ).resolves.toMatchObject({
      conflict: { code: 'REVISION_CONFLICT' },
      kind: 'conflict',
    });
    expect(reconcileCalls).toBe(0);
  });

  it('returns only the accepted final begin-reconciliation replay after a resolver race', async () => {
    const base = new LogicalRunStoreFake(1_500);
    base.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 2,
          status: 'unknown',
        }),
      ],
      nodes: [executingNodeFixture('unknown', { revision: 2 })],
      runs: [runFixture({ revision: 1 })],
    });
    const counted = storeWithCommitCount(base);
    const observed = authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 });
    const request = {
      authority: observed,
      beginIdempotencyKey: 'begin-final-replay-race',
      planDocument,
    };
    const exactExecutor = {
      contractPin: executorPin,
      execute: async () => ({ kind: 'cancelled' as const }),
      reconcile: async () => ({ kind: 'running' as const }),
    };
    let competitorResult: LifecyclePrepareReconciliationResult | undefined;
    let resolveCalls = 0;
    const lifecycle = createRunLifecycle({
      executors: {
        resolveExact: async () => {
          resolveCalls += 1;
          competitorResult = await createRunLifecycle({
            executors: resolverReturning({ executor: exactExecutor, kind: 'resolved' }),
            store: counted.store,
          }).prepareReconciliation(request);
          return { executor: exactExecutor, kind: 'resolved' as const };
        },
      },
      store: counted.store,
    });

    const result = await lifecycle.prepareReconciliation(request);

    expect(competitorResult).toMatchObject({ kind: 'committed' });
    expect(result).toMatchObject({
      kind: 'replayed',
      value: { attemptPhase: 'reconciling', attemptRevision: 3 },
    });
    expect(result.kind === 'replayed' && Object.hasOwn(result.value, 'reconcile')).toBe(false);
    expect(resolveCalls).toBe(1);
    expect(counted.commits()).toBe(1);
    await expect(
      base.transaction(async (transaction) => ({
        attempt: await transaction.getAttempt('attempt-1'),
        node: await transaction.getNode('node-1'),
        run: await transaction.getRun('run-1'),
      })),
    ).resolves.toMatchObject({
      attempt: { kind: 'found', value: { revision: 3, status: 'reconciling' } },
      node: { kind: 'found', value: { revision: 2, status: 'unknown' } },
      run: { kind: 'found', value: { revision: 1 } },
    });
  });

  it('fails closed on a malformed final begin-reconciliation replay after resolution', async () => {
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 2,
          status: 'unknown',
        }),
      ],
      nodes: [executingNodeFixture('unknown', { revision: 2 })],
      runs: [runFixture({ revision: 1 })],
    });
    const observed = authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 });
    const lookup = {
      key: 'begin-malformed-final-replay',
      operation: 'begin_reconciliation',
      runId: 'run-1',
      subjectId: 'attempt-1',
    } as const;
    const request = {
      authority: observed,
      beginIdempotencyKey: lookup.key,
      planDocument,
    };
    const exactExecutor = {
      contractPin: executorPin,
      execute: async () => ({ kind: 'cancelled' as const }),
      reconcile: async () => ({ kind: 'running' as const }),
    };
    let resolveCalls = 0;
    const lifecycle = createRunLifecycle({
      executors: {
        resolveExact: async () => {
          resolveCalls += 1;
          await createRunLifecycle({
            executors: resolverReturning({ executor: exactExecutor, kind: 'resolved' }),
            store,
          }).prepareReconciliation(request);
          const accepted = await store.transaction((transaction) =>
            transaction.getIdempotency(lookup),
          );
          if (accepted.kind !== 'found') throw new TypeError('Expected accepted replay record.');
          store.seed({
            idempotency: [{ lookup, record: { ...accepted.value, result: null } }],
          });
          return { executor: exactExecutor, kind: 'resolved' as const };
        },
      },
      store,
    });

    await expect(lifecycle.prepareReconciliation(request)).resolves.toEqual({
      fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
      kind: 'fault',
    });
    expect(resolveCalls).toBe(1);
    await expect(
      store.transaction(async (transaction) => ({
        attempt: await transaction.getAttempt('attempt-1'),
        node: await transaction.getNode('node-1'),
        run: await transaction.getRun('run-1'),
      })),
    ).resolves.toMatchObject({
      attempt: { kind: 'found', value: { revision: 3, status: 'reconciling' } },
      node: { kind: 'found', value: { revision: 2, status: 'unknown' } },
      run: { kind: 'found', value: { revision: 1 } },
    });
  });

  it('rejects hostile top-level caller input without invoking accessors', async () => {
    const store = new LogicalRunStoreFake(1_500);
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'authority', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    const lifecycle = createRunLifecycle({
      executors: { resolveExact: async () => ({ fault: unknownFault, kind: 'unavailable' }) },
      store,
    });
    const process: CallableFunction = lifecycle.processExecuteObservation.bind(lifecycle);
    const result: unknown = await Reflect.apply(process, undefined, [hostile]);
    expect(result).toEqual({
      fault: { code: 'INVALID_INPUT', message: 'Lifecycle input is invalid.' },
      kind: 'fault',
    });
    expect(getterCalls).toBe(0);
  });

  it('does not begin reconciliation when the exact executor lacks the capability', async () => {
    const base = new LogicalRunStoreFake(1_500);
    base.seed({
      attempts: [
        attemptFixture({
          executorConfigurationDigest: configurationDigest,
          revision: 2,
          status: 'unknown',
        }),
      ],
      nodes: [executingNodeFixture('unknown', { revision: 2 })],
      runs: [runFixture({ revision: 1 })],
    });
    const counted = storeWithCommitCount(base);
    const lifecycle = createRunLifecycle({
      executors: {
        resolveExact: async () => ({
          executor: {
            contractPin: executorPin,
            execute: async () => ({ kind: 'cancelled' as const }),
          },
          kind: 'resolved',
        }),
      },
      store: counted.store,
    });

    await expect(
      lifecycle.prepareReconciliation({
        authority: authority('unknown', 'unknown', { attempt: 2, node: 2, run: 1 }),
        beginIdempotencyKey: 'begin-reconcile-absent',
        planDocument,
      }),
    ).resolves.toMatchObject({
      fault: { code: 'UNKNOWN_OUTCOME' },
      kind: 'fault',
    });
    expect(counted.commits()).toBe(0);
  });
});

const unknownFault = {
  code: 'EXECUTOR_UNAVAILABLE' as const,
  message: 'unused',
};
