import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { describe, expect, it, vi } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { ExecutorContractPin } from '../../src/index.js';
import { createRunLifecycle } from '../../src/lifecycle/construction.js';
import { digestCanonicalJson } from '../../src/policy/index.js';
import type { ManagerLifecycleIdempotencyPurpose } from '../../src/ports/index.js';
import type { RunStoreCommitCommand, RunStoreTransaction } from '../../src/storage/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';

const createPlan = () => {
  const compilation = compilePipeline(
    definePipeline({
      schemaVersion: 1,
      entry: 'work',
      facts: [],
      nodes: [
        {
          kind: 'task',
          key: 'work',
          outcomes: { completed: 'done', failed: 'done', cancelled: 'done', skipped: 'done' },
        },
        { kind: 'terminal', key: 'done', outcome: 'done' },
      ],
    }),
  );
  if (!compilation.ok) throw new Error('Test pipeline did not compile.');
  const executor = { adapterId: 'test', revision: '1', digest: 'executor-digest' };
  const executorBindings = [
    {
      configuration: { mode: 'test' },
      configurationDigest: digestCanonicalJson({ mode: 'test' }),
      executor,
      idempotentExecution: false,
      nodeKey: 'work',
      retryPolicy: {
        backoffMultiplier: 1,
        initialBackoffMs: 0,
        maximumAttempts: 1,
        maximumBackoffMs: 0,
      },
      timeoutPolicy: {
        cancellationTimeoutMs: 100,
        executionTimeoutMs: 100,
        reconciliationTimeoutMs: 100,
      },
    },
  ];
  const terminalBindings = [{ nodeKey: 'done', outcome: 'done', status: 'succeeded' as const }];
  const pin = {
    id: 'plan',
    revision: '1',
    digest: digestCanonicalJson({
      id: 'plan',
      revision: '1',
      compiledPipeline: compilation.pipeline,
      executorBindings,
      terminalBindings,
    }),
  };
  return {
    compiledPipeline: compilation.pipeline,
    executor,
    executorBindings,
    pin,
    terminalBindings,
  };
};

const createIds = () => {
  let sequence = 0;
  const next = (purpose: string) => `${purpose}-${++sequence}`;
  return {
    nextAttemptId: () => next('attempt'),
    nextHandoffId: () => next('handoff'),
    nextLifecycleIdempotencyKey: (purpose: ManagerLifecycleIdempotencyPurpose) => next(purpose),
    nextManagerIncarnationId: () => next('manager'),
    nextOutputId: () => next('output'),
    nextProgressionAllocationSeed: () => next('allocation'),
    nextProgressionOccurrenceKey: () => next('occurrence'),
    nextRunId: () => next('run'),
  };
};

const adapt = (dependencies: {
  readonly store: object;
  readonly plans: object;
  readonly executors: object;
  readonly ids: object;
  readonly coordination?: {
    readonly heartbeatIntervalMs?: number;
    readonly leaseDurationMs?: number;
    readonly pollIntervalMs?: number;
    readonly drainTimeoutMs?: number;
  };
}) => ({
  ...dependencies,
  executors: { kind: 'run_manager_executors' as const, source: dependencies.executors },
  ids: { kind: 'run_manager_identifiers' as const, source: dependencies.ids },
  plans: { kind: 'run_manager_plans' as const, source: dependencies.plans },
  store: { kind: 'run_manager_persistence' as const, source: dependencies.store },
});

describe('RunManager', () => {
  it('hands off and prevents late executor results from writing after stop resolves', async () => {
    const store = new LogicalRunStoreFake(2_000);
    let transactionNow = 2_000;
    const persistence = {
      discover: (query: Parameters<typeof store.discover>[0]) => store.discover(query),
      getRun: (runId: string) => store.getRun(runId),
      listRuns: (query: Parameters<typeof store.listRuns>[0]) => store.listRuns(query),
      readEvents: (query: Parameters<typeof store.readEvents>[0]) => store.readEvents(query),
      transaction: <Result>(callback: Parameters<typeof store.transaction<Result>>[0]) => {
        store.advanceTransactionNow(++transactionNow);
        return store.transaction(callback);
      },
    };
    const plan = createPlan();
    const { executor: _executor, ...planDocument } = plan;
    let resolveExecution: (() => void) | undefined;
    let executionSignal: AbortSignal | undefined;
    const invoked = new Promise<void>((resolve) => {
      resolveExecution = resolve;
    });
    let finishExecution:
      | ((value: { readonly kind: 'succeeded'; readonly outputs: [] }) => void)
      | undefined;
    const execution = new Promise<{ readonly kind: 'succeeded'; readonly outputs: [] }>(
      (resolve) => {
        finishExecution = resolve;
      },
    );
    const manager = createRunManager(
      adapt({
        coordination: {
          drainTimeoutMs: 10,
          heartbeatIntervalMs: 500,
          leaseDurationMs: 2_000,
          pollIntervalMs: 1,
        },
        executors: {
          resolveExact: async (pin: ExecutorContractPin) => ({
            kind: 'resolved',
            executor: {
              contractPin: pin,
              execute: (_request: { readonly signal: AbortSignal }) => {
                executionSignal = _request.signal;
                resolveExecution?.();
                return execution;
              },
            },
          }),
        },
        ids: createIds(),
        plans: { loadExact: async () => ({ kind: 'loaded', planDocument }) },
        store: persistence,
      }),
    );
    const run = await manager.startRun({
      idempotencyKey: 'late-result',
      input: null,
      plan: plan.pin,
    });
    await manager.start();
    await invoked;
    await manager.stop({ drain: true });
    expect(executionSignal?.aborted).toBe(true);
    const handoffs = await store.discover({
      kinds: ['handoff_attempt'],
      limit: 10,
      renewal: null,
      scan: { kind: 'start' },
    });
    expect(handoffs).toMatchObject({
      kind: 'page',
      page: { items: [{ kind: 'handoff_attempt' }] },
    });
    if (handoffs.kind !== 'page') throw new Error('Expected handoff discovery page.');
    expect(handoffs.page.items).toHaveLength(1);
    finishExecution?.({ kind: 'succeeded', outputs: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(manager.getRun(run.id)).resolves.toMatchObject({ status: 'running' });
  });

  it('restarts start-committed handoff work by reconciliation without redispatch', async () => {
    const store = new LogicalRunStoreFake(2_000);
    let transactionNow = 2_000;
    let reconciliationRenewals = 0;
    const persistence = {
      discover: (query: Parameters<typeof store.discover>[0]) => store.discover(query),
      getRun: (runId: string) => store.getRun(runId),
      listRuns: (query: Parameters<typeof store.listRuns>[0]) => store.listRuns(query),
      readEvents: (query: Parameters<typeof store.readEvents>[0]) => store.readEvents(query),
      transaction: <Result>(callback: Parameters<typeof store.transaction<Result>>[0]) => {
        transactionNow += 500;
        store.advanceTransactionNow(transactionNow);
        return store.transaction((transaction) =>
          callback({
            ...transaction,
            commit: (command: RunStoreCommitCommand) => {
              if (
                command.kind === 'apply_incumbent_transition' &&
                command.operation === 'renew_lease'
              ) {
                reconciliationRenewals += 1;
              }
              return transaction.commit(command);
            },
          }),
        );
      },
    };
    const plan = createPlan();
    const { executor: _executor, ...planDocument } = plan;
    let executions = 0;
    let reconciliations = 0;
    let markInvoked: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      markInvoked = resolve;
    });
    const neverSettles = new Promise<never>(() => undefined);
    let markReconciling: (() => void) | undefined;
    const reconciling = new Promise<void>((resolve) => {
      markReconciling = resolve;
    });
    let finishReconciliation:
      | ((value: { readonly kind: 'succeeded'; readonly outputs: [] }) => void)
      | undefined;
    const reconciliation = new Promise<{ readonly kind: 'succeeded'; readonly outputs: [] }>(
      (resolve) => {
        finishReconciliation = resolve;
      },
    );
    const resolver = {
      resolveExact: async (pin: ExecutorContractPin) => ({
        kind: 'resolved' as const,
        executor: {
          contractPin: pin,
          execute: () => {
            executions += 1;
            markInvoked?.();
            return executions === 1
              ? neverSettles
              : Promise.resolve({ kind: 'succeeded' as const, outputs: [] });
          },
          reconcile: () => {
            reconciliations += 1;
            markReconciling?.();
            return reconciliation;
          },
        },
      }),
    };
    const options = (ids: ReturnType<typeof createIds>) =>
      adapt({
        coordination: {
          drainTimeoutMs: 10,
          heartbeatIntervalMs: 500,
          leaseDurationMs: 10_000,
          pollIntervalMs: 1,
        },
        executors: resolver,
        ids,
        plans: { loadExact: async () => ({ kind: 'loaded' as const, planDocument }) },
        store: persistence,
      });
    const ids = createIds();
    const first = createRunManager(options(ids));
    const run = await first.startRun({
      idempotencyKey: 'recover-handoff',
      input: null,
      plan: plan.pin,
    });
    await first.start();
    await invoked;
    await first.stop({ drain: false });
    const incumbent = await store.transaction(async (transaction) =>
      transaction.listAttempts({
        cursor: null,
        limit: 10,
        managerIncarnationId: null,
        nodeInstanceId: null,
        runId: run.id,
        statuses: ['start_committed'],
      }),
    );
    if (incumbent.kind !== 'page' || incumbent.page.items[0] === undefined) {
      throw new Error('Expected incumbent Attempt.');
    }
    const oldAttempt = incumbent.page.items[0];

    const second = createRunManager(options(ids));
    const fresh = await second.startRun({
      idempotencyKey: 'fresh-behind-recovery',
      input: null,
      plan: plan.pin,
    });
    let startResolved = false;
    const starting = second.start().then(() => {
      startResolved = true;
    });
    await reconciling;
    expect(startResolved).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(reconciliationRenewals).toBeGreaterThan(0);
    expect(executions).toBe(1);
    const successor = await store.transaction(async (transaction) =>
      transaction.listAttempts({
        cursor: null,
        limit: 10,
        managerIncarnationId: null,
        nodeInstanceId: null,
        runId: run.id,
        statuses: ['reconciling'],
      }),
    );
    if (successor.kind !== 'page' || successor.page.items[0] === undefined) {
      throw new Error('Expected successor Attempt.');
    }
    expect(successor.page.items[0]).toMatchObject({ fencingToken: 2 });
    expect(successor.page.items[0].managerIncarnationId).not.toBe(oldAttempt.managerIncarnationId);
    const lifecycle = createRunLifecycle({ executors: resolver, store: persistence });
    await expect(
      lifecycle.hydrateOwnedAuthority({
        attemptId: oldAttempt.id,
        expectedAttemptFence: oldAttempt.fencingToken,
        expectedManagerIncarnationId: oldAttempt.managerIncarnationId,
        expectedPhase: 'start_committed',
        nodeInstanceId: oldAttempt.nodeInstanceId,
        runId: oldAttempt.runId,
      }),
    ).resolves.toMatchObject({ kind: 'conflict' });
    finishReconciliation?.({ kind: 'succeeded', outputs: [] });
    await starting;
    await vi.waitFor(
      async () => {
        await expect(second.getRun(run.id)).resolves.toMatchObject({ status: 'succeeded' });
        await expect(second.getRun(fresh.id)).resolves.toMatchObject({ status: 'succeeded' });
      },
      { timeout: 3_000 },
    );
    expect(executions).toBe(2);
    expect(reconciliations).toBe(1);
    await second.stop({ drain: true });
  });

  it.each(['handoff', 'expired'] as const)(
    'acquires a claimed %s Attempt under a new fence and starts it once',
    async (recoveryEvidence) => {
      const store = new LogicalRunStoreFake(2_000);
      let transactionNow = 2_000;
      const persistence = {
        discover: (query: Parameters<typeof store.discover>[0]) => store.discover(query),
        getRun: (runId: string) => store.getRun(runId),
        listRuns: (query: Parameters<typeof store.listRuns>[0]) => store.listRuns(query),
        readEvents: (query: Parameters<typeof store.readEvents>[0]) => store.readEvents(query),
        transaction: <Result>(callback: Parameters<typeof store.transaction<Result>>[0]) => {
          store.advanceTransactionNow(++transactionNow);
          return store.transaction(callback);
        },
      };
      const plan = createPlan();
      const { executor: _executor, ...planDocument } = plan;
      let executions = 0;
      const resolver = {
        resolveExact: async (pin: ExecutorContractPin) => ({
          kind: 'resolved' as const,
          executor: {
            contractPin: pin,
            execute: async () => {
              executions += 1;
              return { kind: 'succeeded' as const, outputs: [] };
            },
          },
        }),
      };
      const ids = createIds();
      const manager = createRunManager(
        adapt({
          coordination: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000, pollIntervalMs: 1 },
          executors: resolver,
          ids,
          plans: { loadExact: async () => ({ kind: 'loaded' as const, planDocument }) },
          store: persistence,
        }),
      );
      const run = await manager.startRun({
        idempotencyKey: 'claimed-handoff',
        input: null,
        plan: plan.pin,
      });
      const lifecycle = createRunLifecycle({ executors: resolver, store: persistence });
      const discovery = await lifecycle.discover({
        kinds: ['claimable_node'],
        limit: 1,
        renewal: null,
        scan: { kind: 'start' },
      });
      const candidate = discovery.kind === 'page' ? discovery.page.items[0] : undefined;
      if (candidate?.kind !== 'claimable_node') throw new Error('Expected claimable node.');
      const claimed = await lifecycle.claim({
        candidate,
        generatedAttemptId: 'old-attempt',
        generatedDispatchIdempotencyKey: 'old-dispatch',
        idempotencyKey: 'old-claim',
        leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
        managerIncarnationId: 'old-manager',
        ownerLabel: 'old-owner',
        planDocument,
      });
      if (claimed.kind !== 'committed') throw new Error('Expected claimed Attempt.');
      if (recoveryEvidence === 'handoff') {
        const handedOff = await lifecycle.writeHandoff({
          authority: claimed.value.authority,
          generatedHandoffId: 'old-handoff',
          idempotencyKey: 'old-handoff-write',
          reason: 'manager_shutdown',
        });
        if (handedOff.kind !== 'committed') throw new Error('Expected durable handoff.');
      } else {
        transactionNow = claimed.value.authority.leaseExpiresAt;
        store.advanceTransactionNow(transactionNow);
      }

      await manager.start();
      await vi.waitFor(async () => {
        await expect(manager.getRun(run.id)).resolves.toMatchObject({ status: 'succeeded' });
      });
      expect(executions).toBe(1);
      await manager.stop({ drain: true });
    },
  );

  it('renews active execution authority before the lease expires', async () => {
    const store = new LogicalRunStoreFake(2_000);
    const plan = createPlan();
    const { executor: _executor, ...planDocument } = plan;
    let renewals = 0;
    let transactionNow = 2_000;
    const persistence = {
      discover: (query: Parameters<typeof store.discover>[0]) => store.discover(query),
      getRun: (runId: string) => store.getRun(runId),
      listRuns: (query: Parameters<typeof store.listRuns>[0]) => store.listRuns(query),
      readEvents: (query: Parameters<typeof store.readEvents>[0]) => store.readEvents(query),
      transaction: <Result>(callback: (transaction: RunStoreTransaction) => Promise<Result>) => {
        transactionNow += 100;
        store.advanceTransactionNow(transactionNow);
        return store.transaction((transaction) =>
          callback({
            ...transaction,
            commit: (command: RunStoreCommitCommand) => {
              if (
                command.kind === 'apply_incumbent_transition' &&
                command.operation === 'renew_lease'
              ) {
                renewals += 1;
              }
              return transaction.commit(command);
            },
          }),
        );
      },
    };
    const manager = createRunManager(
      adapt({
        coordination: { heartbeatIntervalMs: 100, leaseDurationMs: 1_000, pollIntervalMs: 1 },
        executors: {
          resolveExact: async (pin: ExecutorContractPin) => ({
            kind: 'resolved',
            executor: {
              contractPin: pin,
              execute: async () => {
                await new Promise((resolve) => setTimeout(resolve, 250));
                return { kind: 'succeeded', outputs: [] } as const;
              },
            },
          }),
        },
        ids: createIds(),
        plans: { loadExact: async () => ({ kind: 'loaded', planDocument }) },
        store: persistence,
      }),
    );
    const run = await manager.startRun({
      idempotencyKey: 'heartbeat',
      input: null,
      plan: plan.pin,
    });
    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(manager.stop({ drain: true })).resolves.toBeUndefined();
    expect(renewals).toBeGreaterThan(0);
    await expect(manager.getRun(run.id)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('binds startRun idempotency globally across sequential and concurrent calls', async () => {
    const plan = createPlan();
    const { executor: _executor, ...planDocument } = plan;
    const manager = createRunManager(
      adapt({
        executors: {
          resolveExact: async () => ({
            kind: 'unavailable',
            fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'unused' },
          }),
        },
        ids: createIds(),
        plans: { loadExact: async () => ({ kind: 'loaded', planDocument }) },
        store: new LogicalRunStoreFake(2_000),
      }),
    );
    const command = { idempotencyKey: 'start-global', input: { value: 1 }, plan: plan.pin };

    const first = await manager.startRun(command);
    await expect(manager.startRun(command)).resolves.toEqual(first);
    await expect(
      Promise.all([manager.startRun(command), manager.startRun(command)]),
    ).resolves.toEqual([first, first]);
    await expect(manager.startRun({ ...command, input: { value: 2 } })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('executes one exact task only after durable claim and Start CAS, then terminalizes the Run', async () => {
    const store = new LogicalRunStoreFake(2_000);
    let transactionNow = 2_000;
    const advancingStore = {
      discover: (query: Parameters<typeof store.discover>[0]) => store.discover(query),
      getRun: (runId: string) => store.getRun(runId),
      listRuns: (query: Parameters<typeof store.listRuns>[0]) => store.listRuns(query),
      readEvents: (query: Parameters<typeof store.readEvents>[0]) => store.readEvents(query),
      transaction: <Result>(callback: Parameters<typeof store.transaction<Result>>[0]) => {
        store.advanceTransactionNow(++transactionNow);
        return store.transaction(callback);
      },
    };
    const plan = createPlan();
    const { executor: _executor, ...planDocument } = plan;
    let executions = 0;
    const manager = createRunManager(
      adapt({
        coordination: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000, pollIntervalMs: 1 },
        executors: {
          resolveExact: async (pin: ExecutorContractPin) => ({
            kind: 'resolved',
            executor: {
              contractPin: pin,
              execute: async () => {
                executions += 1;
                return {
                  kind: 'succeeded',
                  outputs: [{ name: 'result', payload: { kind: 'json', value: { ok: true } } }],
                };
              },
            },
          }),
        },
        ids: createIds(),
        plans: { loadExact: async () => ({ kind: 'loaded', planDocument }) },
        store: advancingStore,
      }),
    );

    const created = await manager.startRun({
      idempotencyKey: 'request-1',
      input: { value: 1 },
      plan: plan.pin,
    });
    expect(created.status).toBe('running');
    await manager.start();
    await vi.waitFor(async () => {
      await expect(manager.getRun(created.id)).resolves.toMatchObject({ status: 'succeeded' });
    });
    expect(executions).toBe(1);
    await manager.stop({ drain: true });
  });

  it('fails closed with stable PLAN_UNSUPPORTED behavior for another topology', async () => {
    const plan = createPlan();
    const { executor: _executor, ...supportedDocument } = plan;
    const unsupported = {
      ...supportedDocument,
      compiledPipeline: {
        ...supportedDocument.compiledPipeline,
        facts: [{ key: 'extra', type: 'string' as const }],
      },
    };
    const manager = createRunManager(
      adapt({
        executors: {
          resolveExact: async () => ({
            kind: 'unavailable',
            fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'unused' },
          }),
        },
        ids: createIds(),
        plans: { loadExact: async () => ({ kind: 'loaded', planDocument: unsupported }) },
        store: new LogicalRunStoreFake(2_000),
      }),
    );

    await expect(
      manager.startRun({ idempotencyKey: 'unsupported', input: null, plan: plan.pin }),
    ).rejects.toThrow('PLAN_UNSUPPORTED');
  });
});
