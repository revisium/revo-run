import { describe, expect, it, vi } from 'vitest';

import type {
  LifecycleDiscoveryCandidate,
  LifecycleDiscoveryResult,
  LifecycleExecuteObservation,
  LifecycleProcessObservationResult,
  LifecycleWriteHandoffResult,
  RunLifecycle,
} from '../../src/lifecycle/index.js';
import { buildRunManager } from '../../src/manager/index.js';
import type {
  ExecutionPlanSource,
  LocalClock,
  LocalScheduler,
  ManagerIdSource,
  ScheduledTask,
} from '../../src/ports/index.js';
import type { RunExecutionPlanDocument } from '../../src/spec/index.js';

const plan: RunExecutionPlanDocument = Object.freeze({
  compiledPipeline: null,
  executorBindings: Object.freeze([
    Object.freeze({
      configuration: null,
      configurationDigest:
        'sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      executor: Object.freeze({ adapterId: 'adapter-a', digest: 'executor', revision: '1' }),
      idempotentExecution: false,
      nodeKey: 'node-a',
      retryPolicy: Object.freeze({
        backoffMultiplier: 2,
        initialBackoffMs: 100,
        maximumAttempts: 3,
        maximumBackoffMs: 1_000,
      }),
      timeoutPolicy: Object.freeze({
        cancellationTimeoutMs: 1_000,
        executionTimeoutMs: 10_000,
        reconciliationTimeoutMs: 10_000,
      }),
    }),
  ]),
  pin: Object.freeze({ digest: 'plan-digest', id: 'plan', revision: '1' }),
  terminalBindings: Object.freeze([]),
});

const claimable = (): LifecycleDiscoveryCandidate => ({
  attempt: null,
  eligibleAt: 0,
  handoffId: null,
  kind: 'claimable_node',
  node: {
    activeAttemptId: null,
    nodeInstanceId: 'node-instance-1',
    nodeKey: 'node-a',
    nodeRevision: 0,
  },
  run: { planPin: plan.pin, runId: 'run-1', runRevision: 0 },
});

const startedAuthority = () => ({
  activationId: 'activation-1',
  attemptId: 'attempt-1',
  attemptPhase: 'start_committed' as const,
  dispatchIdempotencyKey: 'dispatch-1',
  executorConfigurationDigest:
    'sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b' as const,
  executorContractPin: plan.executorBindings[0]!.executor,
  expectedAttemptRevision: 1,
  expectedNodeRevision: 1,
  expectedRunRevision: 1,
  fencingToken: 1,
  leaseExpiresAt: 10_000,
  managerIncarnationId: 'manager-1',
  nodeInstanceId: 'node-instance-1',
  nodeKey: 'node-a',
  nodePhase: 'executing' as const,
  planPin: plan.pin,
  runId: 'run-1',
});

const unknownAuthority = () => ({
  ...startedAuthority(),
  attemptPhase: 'unknown' as const,
  expectedAttemptRevision: 2,
  nodePhase: 'unknown' as const,
});

const expired = (): Extract<LifecycleDiscoveryCandidate, { readonly kind: 'expired_attempt' }> => ({
  attempt: {
    attemptId: 'attempt-1',
    attemptPhase: 'unknown',
    attemptRevision: 1,
    fencingToken: 1,
    leaseExpiresAt: 0,
    managerIncarnationId: 'manager-old',
  },
  eligibleAt: 0,
  handoffId: null,
  kind: 'expired_attempt',
  node: {
    activeAttemptId: 'attempt-1',
    nodeInstanceId: 'node-instance-1',
    nodeKey: 'node-a',
    nodeRevision: 1,
  },
  run: { planPin: plan.pin, runId: 'run-1', runRevision: 1 },
});

const renewable = (): Extract<
  LifecycleDiscoveryCandidate,
  { readonly kind: 'renewable_attempt' }
> => ({
  ...expired(),
  attempt: {
    ...expired().attempt,
    leaseExpiresAt: 10_000,
    managerIncarnationId: 'manager-1',
  },
  kind: 'renewable_attempt',
});

class ManualScheduler implements LocalScheduler {
  readonly queued: Array<() => void> = [];
  readonly waits: Array<{
    readonly delayMs: number;
    readonly signal: AbortSignal;
    reject: (error: Error) => void;
    resolve: () => void;
  }> = [];

  enqueue(task: () => void): ScheduledTask {
    this.queued.push(task);
    return Object.freeze({
      cancel: () => {
        const index = this.queued.indexOf(task);
        if (index >= 0) this.queued.splice(index, 1);
      },
    });
  }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      this.waits.push({ delayMs, reject, resolve, signal });
    });
  }

  runNext(): void {
    this.queued.shift()?.();
  }
}

const managerIds = (): ManagerIdSource => {
  let value = 0;
  return {
    nextAttemptId: () => `attempt-${++value}`,
    nextHandoffId: () => `handoff-${++value}`,
    nextLifecycleIdempotencyKey: (purpose) => `${purpose}-${++value}`,
    nextManagerIncarnationId: () => `manager-${++value}`,
    nextOutputId: () => `output-${++value}`,
  };
};

const dependenciesFor = (
  lifecycle: RunLifecycle,
  scheduler: LocalScheduler,
  plans: ExecutionPlanSource,
) => ({
  clock: { now: () => 0 } satisfies LocalClock,
  ids: managerIds(),
  lifecycle,
  plans,
  scheduler,
});

const lifecycleStub = (overrides: Partial<RunLifecycle> = {}): RunLifecycle => ({
  acquire: vi.fn<RunLifecycle['acquire']>(),
  claim: vi.fn<RunLifecycle['claim']>(),
  discover: vi.fn<RunLifecycle['discover']>(),
  hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(),
  prepareReconciliation: vi.fn<RunLifecycle['prepareReconciliation']>(),
  processExecuteObservation: vi.fn<RunLifecycle['processExecuteObservation']>(),
  processReconcileObservation: vi.fn<RunLifecycle['processReconcileObservation']>(),
  renewLease: vi.fn<RunLifecycle['renewLease']>(),
  verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(),
  writeHandoff: vi.fn<RunLifecycle['writeHandoff']>(),
  ...overrides,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <Value>() => {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return {
    promise,
    resolve: (value: Value) => resolve?.(value),
  };
};

const committedHandoff = (
  request: Parameters<RunLifecycle['writeHandoff']>[0],
): LifecycleWriteHandoffResult => ({
  cursor: { runId: request.authority.runId, sequence: 9 },
  kind: 'committed',
  transactionNow: 9,
  value: {
    attemptId: request.authority.attemptId,
    handoffId: request.generatedHandoffId,
    incumbentFencingToken: request.authority.fencingToken,
  },
});

describe('internal RunManager supervisor', () => {
  it('defensively validates local coordination configuration', () => {
    const scheduler = new ManualScheduler();
    const dependencies = dependenciesFor(lifecycleStub(), scheduler, {
      loadExact: vi.fn<ExecutionPlanSource['loadExact']>(),
    });

    expect(() => buildRunManager(dependencies, { ownerLabel: '' })).toThrow(
      'RunManager owner label is invalid.',
    );
    expect(() => buildRunManager(dependencies, { pollIntervalMs: 0 })).toThrow(
      'RunManager coordination value is invalid.',
    );
    expect(() =>
      buildRunManager(dependencies, {
        concurrency: {
          maximumConcurrentExecutions: 1,
          maximumConcurrentExecutionsPerExecutor: 2,
        },
      }),
    ).toThrow('Per-executor concurrency must not exceed global process-local concurrency.');
    expect(() =>
      buildRunManager(dependencies, {
        lease: { heartbeatIntervalMs: 1_000, leaseDurationMs: 1_000 },
      }),
    ).toThrow('Heartbeat interval must be strictly less than lease duration.');
  });

  it('serializes concurrent start/stop and allocates one incarnation per start', async () => {
    const scheduler = new ManualScheduler();
    const lifecycle = lifecycleStub({
      discover: vi.fn<RunLifecycle['discover']>(
        async (): Promise<LifecycleDiscoveryResult> => ({
          kind: 'page',
          page: { highWatermark: 0, items: [], next: null },
        }),
      ),
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    const first = manager.start();
    const second = manager.start();
    await Promise.all([first, second]);
    expect(manager.state).toBe('running');
    expect(manager.managerIncarnationId).toBe('manager-1');

    scheduler.runNext();
    await flush();
    scheduler.waits.at(-1)?.resolve();
    await flush();

    const stopA = manager.stop({ timeoutMs: 1_000 });
    const stopB = manager.stop();
    await Promise.all([stopA, stopB]);
    expect(manager.state).toBe('stopped');

    await manager.start();
    expect(manager.managerIncarnationId).toBe('manager-2');
    await manager.stop();
  });

  it('returns to stopped when starting recovery discovery fails', async () => {
    const scheduler = new ManualScheduler();
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            fault: { code: 'PLAN_UNAVAILABLE', message: 'unavailable' },
            kind: 'fault',
          })),
        }),
        scheduler,
        { loadExact: vi.fn<ExecutionPlanSource['loadExact']>() },
      ),
    );

    await expect(manager.start()).rejects.toThrow('RunManager discovery failed.');
    expect(manager.state).toBe('stopped');
  });

  it('continues an opaque discovery scan through its fixed high-watermark cursor', async () => {
    const scheduler = new ManualScheduler();
    const cursor = {
      highWatermark: 7,
      kinds: ['claimable_node' as const],
      last: {
        attemptId: null,
        eligibleAt: 0,
        kind: 'claimable_node' as const,
        nodeInstanceId: 'node-instance-1',
        runId: 'run-1',
      },
      renewal: null,
    };
    const discover = vi
      .fn<RunLifecycle['discover']>()
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 7, items: [], next: cursor },
      })
      .mockResolvedValue({
        kind: 'page',
        page: { highWatermark: 7, items: [], next: null },
      });
    const manager = buildRunManager(
      dependenciesFor(lifecycleStub({ discover }), scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(),
      }),
    );

    await manager.start();
    expect(discover.mock.calls[1]?.[0].scan).toEqual({ cursor, kind: 'continue' });
    await manager.stop();
  });

  it('owns poll discovery and retry-wait rejections without an unhandled promise', async () => {
    const scheduler = new ManualScheduler();
    const discover = vi
      .fn<RunLifecycle['discover']>()
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 0, items: [], next: null },
      })
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 0, items: [], next: null },
      })
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 0, items: [], next: null },
      })
      .mockRejectedValue(new Error('poll discovery failed'));
    const manager = buildRunManager(
      dependenciesFor(lifecycleStub({ discover }), scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(),
      }),
      {
        pollRetry: {
          backoffMultiplier: 2,
          initialBackoffMs: 250,
          maximumAttempts: 2,
          maximumBackoffMs: 500,
        },
      },
    );

    await manager.start();
    scheduler.runNext();
    await flush();
    expect(scheduler.queued).toHaveLength(0);
    scheduler.waits.find((wait) => wait.delayMs === 250)?.resolve();
    await flush();
    expect(scheduler.queued).toHaveLength(1);
    scheduler.runNext();
    await flush();
    expect(scheduler.queued).toHaveLength(0);
    scheduler.waits.at(-1)?.reject(new Error('retry wait failed'));
    await flush();
    expect(manager.state).toBe('stopped');
    expect(scheduler.queued).toHaveLength(0);
    expect(discover).toHaveBeenCalledTimes(4);
  });

  it('routes an ordinary poll-wait rejection through one successful backoff successor', async () => {
    const scheduler = new ManualScheduler();
    const discover = vi.fn<RunLifecycle['discover']>(async () => ({
      kind: 'page',
      page: { highWatermark: 0, items: [], next: null },
    }));
    const manager = buildRunManager(
      dependenciesFor(lifecycleStub({ discover }), scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(),
      }),
      {
        pollRetry: {
          backoffMultiplier: 2,
          initialBackoffMs: 100,
          maximumAttempts: 2,
          maximumBackoffMs: 200,
        },
      },
    );

    await manager.start();
    scheduler.runNext();
    await flush();
    scheduler.waits.find((wait) => wait.delayMs === 250)?.reject(new Error('poll wait failed'));
    await flush();
    expect(scheduler.queued).toHaveLength(0);
    scheduler.waits.find((wait) => wait.delayMs === 100)?.resolve();
    await flush();
    expect(scheduler.queued).toHaveLength(1);
    await manager.stop();
  });

  it('stops cleanly after bounded polling recovery is exhausted', async () => {
    const scheduler = new ManualScheduler();
    const discover = vi
      .fn<RunLifecycle['discover']>()
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 0, items: [], next: null },
      })
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 0, items: [], next: null },
      })
      .mockRejectedValue(new Error('persistent discovery failure'));
    const manager = buildRunManager(
      dependenciesFor(lifecycleStub({ discover }), scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(),
      }),
      {
        pollRetry: {
          backoffMultiplier: 2,
          initialBackoffMs: 250,
          maximumAttempts: 1,
          maximumBackoffMs: 500,
        },
      },
    );

    await manager.start();
    scheduler.runNext();
    await flush();
    scheduler.waits.at(-1)?.reject(new Error('poll wait failed'));
    await flush();
    expect(manager.state).toBe('stopped');
    expect(scheduler.queued).toHaveLength(0);
  });

  it('contains poll-exhaustion cleanup through an ambiguous handoff wait rejection', async () => {
    const scheduler = new ManualScheduler();
    const authority = startedAuthority();
    const invocation = deferred<LifecycleExecuteObservation>();
    const discover = vi
      .fn<RunLifecycle['discover']>()
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 1, items: [claimable()], next: null },
      })
      .mockResolvedValueOnce({
        kind: 'page',
        page: { highWatermark: 1, items: [claimable()], next: null },
      })
      .mockRejectedValue(new Error('persistent discovery failure'));
    const writeHandoff = vi
      .fn<RunLifecycle['writeHandoff']>()
      .mockRejectedValueOnce(new Error('ambiguous cleanup result'))
      .mockImplementation(async (request) => committedHandoff(request));
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim: vi.fn<RunLifecycle['claim']>(async () => ({
            cursor: { runId: 'run-1', sequence: 1 },
            kind: 'committed',
            transactionNow: 1,
            value: { authority: { ...authority, attemptPhase: 'claimed' }, ordinal: 1 },
          })),
          discover,
          verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
            cursor: { runId: 'run-1', sequence: 2 },
            kind: 'committed',
            transactionNow: 2,
            value: {
              authority,
              execute: { invoke: () => invocation.promise },
              invocation: {
                activationContext: null,
                attempt: {
                  activationId: 'activation-1',
                  attemptId: 'attempt-1',
                  dispatchIdempotencyKey: 'dispatch-1',
                  nodeInstanceId: 'node-instance-1',
                  nodeKey: 'node-a',
                  runId: 'run-1',
                },
                executorConfiguration: null,
                executorConfigurationDigest: authority.executorConfigurationDigest,
                executorContractPin: authority.executorContractPin,
                runInput: null,
              },
              kind: 'execute',
            },
          })),
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
      {
        pollRetry: {
          backoffMultiplier: 2,
          initialBackoffMs: 250,
          maximumAttempts: 1,
          maximumBackoffMs: 500,
        },
      },
    );

    await manager.start();
    await flush();
    scheduler.runNext();
    await vi.waitFor(() => {
      expect(scheduler.waits.find((wait) => wait.delayMs === 250)).toBeDefined();
    });
    scheduler.waits.find((wait) => wait.delayMs === 250)?.reject(new Error('retry wait failed'));
    await flush();
    await flush();
    expect(writeHandoff).toHaveBeenCalledTimes(2);
    expect(writeHandoff.mock.calls[1]?.[0]).toEqual(writeHandoff.mock.calls[0]?.[0]);
    expect(manager.state).toBe('stopped');
  });

  it('loads the full plan by exact pin and reserves adapter capacity before claim', async () => {
    const scheduler = new ManualScheduler();
    const order: string[] = [];
    const candidate = claimable();
    const claim = vi.fn<RunLifecycle['claim']>(async () => {
      order.push('claim');
      return {
        conflict: { code: 'STALE_FENCE', message: 'stale' },
        kind: 'conflict',
      };
    });
    const lifecycle = lifecycleStub({
      claim,
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page' as const,
        page: { highWatermark: 1, items: [candidate], next: null },
      })),
    });
    const plans: ExecutionPlanSource = {
      loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async (pin) => {
        order.push(`plan:${pin.id}:${pin.revision}:${pin.digest}`);
        return { kind: 'loaded' as const, planDocument: plan };
      }),
    };
    const manager = buildRunManager(dependenciesFor(lifecycle, scheduler, plans), {
      concurrency: {
        maximumConcurrentExecutions: 1,
        maximumConcurrentExecutionsPerExecutor: 1,
      },
    });

    await manager.start();
    await flush();
    expect(order).toEqual(['plan:plan:1:plan-digest', 'claim']);
    expect(claim.mock.calls[0]?.[0].candidate.node.nodeKey).toBe('node-a');
    expect(claim.mock.calls[0]?.[0].planDocument).toEqual(plan);
    await manager.stop();
  });

  it('enforces global and per-executor capacity before a second claim', async () => {
    const scheduler = new ManualScheduler();
    const verification = deferred<Awaited<ReturnType<RunLifecycle['verifyAndStart']>>>();
    const claim = vi.fn<RunLifecycle['claim']>(async () => ({
      cursor: { runId: 'run-1', sequence: 1 },
      kind: 'committed',
      transactionNow: 1,
      value: {
        authority: { ...startedAuthority(), attemptPhase: 'claimed' },
        ordinal: 1,
      },
    }));
    const lifecycle = lifecycleStub({
      claim,
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [claimable(), claimable()], next: null },
      })),
      verifyAndStart: () => verification.promise,
      writeHandoff: vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
        committedHandoff(request),
      ),
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
      {
        concurrency: {
          maximumConcurrentExecutions: 1,
          maximumConcurrentExecutionsPerExecutor: 1,
        },
      },
    );

    await manager.start();
    expect(claim).toHaveBeenCalledOnce();
    verification.resolve({
      fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'unavailable' },
      kind: 'fault',
    });
    await flush();
    await manager.stop();
  });

  it('does not claim when exact plan loading or plan binding validation fails', async () => {
    const scheduler = new ManualScheduler();
    const claim = vi.fn<RunLifecycle['claim']>();
    const lifecycle = lifecycleStub({
      claim,
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [claimable()], next: null },
      })),
    });
    const plans = vi
      .fn<ExecutionPlanSource['loadExact']>()
      .mockResolvedValueOnce({
        fault: { code: 'PLAN_UNAVAILABLE', message: 'unavailable' },
        kind: 'fault',
      })
      .mockResolvedValueOnce({
        kind: 'loaded',
        planDocument: {
          ...plan,
          executorBindings: [
            {
              ...plan.executorBindings[0]!,
              configurationDigest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          ],
        },
      })
      .mockResolvedValue({
        kind: 'loaded',
        planDocument: { ...plan, executorBindings: [] },
      });
    const manager = buildRunManager(dependenciesFor(lifecycle, scheduler, { loadExact: plans }));

    await manager.start();
    scheduler.runNext();
    await flush();
    scheduler.waits.at(-1)?.reject(new Error('handoff retry wait failed'));
    await flush();
    scheduler.runNext();
    await flush();
    expect(claim).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('quiesces an in-flight exact plan load without a late claim', async () => {
    const scheduler = new ManualScheduler();
    const loaded = deferred<Awaited<ReturnType<ExecutionPlanSource['loadExact']>>>();
    const claim = vi.fn<RunLifecycle['claim']>();
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim,
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [claimable()], next: null },
          })),
        }),
        scheduler,
        { loadExact: () => loaded.promise },
      ),
    );

    const starting = manager.start();
    await flush();
    const stopping = manager.stop();
    expect(manager.state).toBe('quiescing');
    loaded.resolve({ kind: 'loaded', planDocument: plan });
    await Promise.all([starting, stopping]);
    expect(claim).not.toHaveBeenCalled();
    expect(manager.state).toBe('stopped');
  });

  it('settles authority committed by an in-flight claim before stopping', async () => {
    const scheduler = new ManualScheduler();
    const claimed = deferred<Awaited<ReturnType<RunLifecycle['claim']>>>();
    const claimStarted = deferred<void>();
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) => ({
      cursor: { runId: request.authority.runId, sequence: 2 },
      kind: 'committed',
      transactionNow: 2,
      value: {
        attemptId: request.authority.attemptId,
        handoffId: request.generatedHandoffId,
        incumbentFencingToken: request.authority.fencingToken,
      },
    }));
    const verifyAndStart = vi.fn<RunLifecycle['verifyAndStart']>();
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim: () => {
            claimStarted.resolve();
            return claimed.promise;
          },
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [claimable()], next: null },
          })),
          verifyAndStart,
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    const starting = manager.start();
    await claimStarted.promise;
    const stopping = manager.stop();
    claimed.resolve({
      cursor: { runId: 'run-1', sequence: 1 },
      kind: 'committed',
      transactionNow: 1,
      value: {
        authority: { ...startedAuthority(), attemptPhase: 'claimed' },
        ordinal: 1,
      },
    });
    await Promise.all([starting, stopping]);
    expect(verifyAndStart).not.toHaveBeenCalled();
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_shutdown');
    expect(manager.state).toBe('stopped');
  });

  it('releases a late in-flight claim conflict before stopping', async () => {
    const scheduler = new ManualScheduler();
    const claimed = deferred<Awaited<ReturnType<RunLifecycle['claim']>>>();
    const claimStarted = deferred<void>();
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim: () => {
            claimStarted.resolve();
            return claimed.promise;
          },
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [claimable()], next: null },
          })),
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    const starting = manager.start();
    await claimStarted.promise;
    const stopping = manager.stop();
    claimed.resolve({
      conflict: { code: 'STALE_FENCE', message: 'stale' },
      kind: 'conflict',
    });
    await Promise.all([starting, stopping]);
    expect(manager.state).toBe('stopped');
  });

  it('hydrates and settles a claim replay returned after quiesce', async () => {
    const scheduler = new ManualScheduler();
    const claimed = deferred<Awaited<ReturnType<RunLifecycle['claim']>>>();
    const claimStarted = deferred<void>();
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim: () => {
            claimStarted.resolve();
            return claimed.promise;
          },
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [claimable()], next: null },
          })),
          hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => ({
            kind: 'hydrated',
            transactionNow: 2,
            value: {
              authority: { ...startedAuthority(), attemptPhase: 'claimed' },
              phase: 'claimed',
              recovery: 'start',
            },
          })),
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    const starting = manager.start();
    await claimStarted.promise;
    const stopping = manager.stop();
    claimed.resolve({
      committedAt: 1,
      cursor: { runId: 'run-1', sequence: 1 },
      kind: 'replayed',
      value: {
        attemptId: 'attempt-1',
        fencingToken: 1,
        nodeInstanceId: 'node-instance-1',
        ordinal: 1,
        runId: 'run-1',
      },
    });
    await Promise.all([starting, stopping]);
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_shutdown');
    expect(manager.state).toBe('stopped');
  });

  it('settles authority committed by an in-flight acquire before stopping', async () => {
    const scheduler = new ManualScheduler();
    const acquired = deferred<Awaited<ReturnType<RunLifecycle['acquire']>>>();
    const acquireStarted = deferred<void>();
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          acquire: () => {
            acquireStarted.resolve();
            return acquired.promise;
          },
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [expired()], next: null },
          })),
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    const starting = manager.start();
    await acquireStarted.promise;
    const stopping = manager.stop();
    acquired.resolve({
      cursor: { runId: 'run-1', sequence: 1 },
      kind: 'committed',
      transactionNow: 1,
      value: {
        authority: unknownAuthority(),
        evidence: { kind: 'lease_expired' },
        recovery: 'reconcile',
      },
    });
    await Promise.all([starting, stopping]);
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_shutdown');
    expect(manager.state).toBe('stopped');
  });

  it('hydrates and settles an acquire replay returned after quiesce', async () => {
    const scheduler = new ManualScheduler();
    const acquired = deferred<Awaited<ReturnType<RunLifecycle['acquire']>>>();
    const acquireStarted = deferred<void>();
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          acquire: () => {
            acquireStarted.resolve();
            return acquired.promise;
          },
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [expired()], next: null },
          })),
          hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => ({
            kind: 'hydrated',
            transactionNow: 2,
            value: { authority: unknownAuthority(), phase: 'unknown', recovery: 'reconcile' },
          })),
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    const starting = manager.start();
    await acquireStarted.promise;
    const stopping = manager.stop();
    acquired.resolve({
      committedAt: 1,
      cursor: { runId: 'run-1', sequence: 1 },
      kind: 'replayed',
      value: {
        attemptId: 'attempt-1',
        nodeInstanceId: 'node-instance-1',
        recovery: 'reconcile',
        runId: 'run-1',
        successorFencingToken: 1,
        successorManagerIncarnationId: 'manager-1',
      },
    });
    await Promise.all([starting, stopping]);
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_shutdown');
    expect(manager.state).toBe('stopped');
  });

  it('settles replay hydration that completes after quiesce', async () => {
    const scheduler = new ManualScheduler();
    const hydrated = deferred<Awaited<ReturnType<RunLifecycle['hydrateOwnedAuthority']>>>();
    const hydrationStarted = deferred<void>();
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          acquire: vi.fn<RunLifecycle['acquire']>(async () => ({
            committedAt: 1,
            cursor: { runId: 'run-1', sequence: 1 },
            kind: 'replayed',
            value: {
              attemptId: 'attempt-1',
              nodeInstanceId: 'node-instance-1',
              recovery: 'reconcile',
              runId: 'run-1',
              successorFencingToken: 1,
              successorManagerIncarnationId: 'manager-1',
            },
          })),
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [expired()], next: null },
          })),
          hydrateOwnedAuthority: () => {
            hydrationStarted.resolve();
            return hydrated.promise;
          },
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    const starting = manager.start();
    await hydrationStarted.promise;
    const stopping = manager.stop();
    hydrated.resolve({
      kind: 'hydrated',
      transactionNow: 2,
      value: { authority: unknownAuthority(), phase: 'unknown', recovery: 'reconcile' },
    });
    await Promise.all([starting, stopping]);
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_shutdown');
    expect(manager.state).toBe('stopped');
  });

  it('hands off a Start committed after quiesce without executing', async () => {
    const scheduler = new ManualScheduler();
    const started = deferred<Awaited<ReturnType<RunLifecycle['verifyAndStart']>>>();
    const startEntered = deferred<void>();
    const execute = vi.fn<(signal: AbortSignal) => Promise<LifecycleExecuteObservation>>(
      async () => ({ kind: 'cancelled' }),
    );
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim: vi.fn<RunLifecycle['claim']>(async () => ({
            cursor: { runId: 'run-1', sequence: 1 },
            kind: 'committed',
            transactionNow: 1,
            value: {
              authority: { ...startedAuthority(), attemptPhase: 'claimed' },
              ordinal: 1,
            },
          })),
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [claimable()], next: null },
          })),
          verifyAndStart: () => {
            startEntered.resolve();
            return started.promise;
          },
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    await manager.start();
    await startEntered.promise;
    const stopping = manager.stop();
    started.resolve({
      cursor: { runId: 'run-1', sequence: 2 },
      kind: 'committed',
      transactionNow: 2,
      value: {
        authority: startedAuthority(),
        execute: { invoke: execute },
        invocation: {
          activationContext: null,
          attempt: {
            activationId: 'activation-1',
            attemptId: 'attempt-1',
            dispatchIdempotencyKey: 'dispatch-1',
            nodeInstanceId: 'node-instance-1',
            nodeKey: 'node-a',
            runId: 'run-1',
          },
          executorConfiguration: null,
          executorConfigurationDigest: startedAuthority().executorConfigurationDigest,
          executorContractPin: startedAuthority().executorContractPin,
          runInput: null,
        },
        kind: 'execute',
      },
    });
    await stopping;
    expect(execute).not.toHaveBeenCalled();
    expect(writeHandoff.mock.calls[0]?.[0].authority.attemptPhase).toBe('start_committed');
    expect(manager.state).toBe('stopped');
  });

  it('maps Start replay directly to unknown and never executes', async () => {
    const scheduler = new ManualScheduler();
    const execute = vi.fn<() => void>();
    const processExecute = vi.fn<RunLifecycle['processExecuteObservation']>(
      async (): Promise<LifecycleProcessObservationResult> => ({
        cursor: { runId: 'run-1', sequence: 2 },
        kind: 'committed',
        transactionNow: 2,
        value: { authority: unknownAuthority(), observation: 'unknown' },
      }),
    );
    const authority = startedAuthority();
    const lifecycle = lifecycleStub({
      claim: vi.fn<RunLifecycle['claim']>(async () => ({
        transactionNow: 1,
        cursor: { runId: 'run-1', sequence: 1 },
        kind: 'committed' as const,
        value: { authority: { ...authority, attemptPhase: 'claimed' as const }, ordinal: 1 },
      })),
      discover: vi
        .fn<RunLifecycle['discover']>()
        .mockResolvedValueOnce({
          kind: 'page',
          page: { highWatermark: 1, items: [claimable()], next: null },
        })
        .mockResolvedValueOnce({
          kind: 'page',
          page: { highWatermark: 1, items: [claimable()], next: null },
        })
        .mockResolvedValue({
          kind: 'page',
          page: { highWatermark: 1, items: [], next: null },
        }),
      hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => ({
        kind: 'hydrated' as const,
        transactionNow: 2,
        value: {
          authority,
          phase: 'start_committed' as const,
          recovery: 'reconcile' as const,
        },
      })),
      processExecuteObservation: processExecute,
      prepareReconciliation: vi.fn<RunLifecycle['prepareReconciliation']>(async () => ({
        conflict: { code: 'STALE_FENCE', message: 'stale' },
        kind: 'conflict',
      })),
      verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
        committedAt: 1,
        cursor: { runId: 'run-1', sequence: 1 },
        kind: 'replayed' as const,
        value: {
          attemptId: 'attempt-1',
          attemptPhase: 'start_committed' as const,
          attemptRevision: 1,
          fencingToken: 1,
          managerIncarnationId: 'manager-1',
          nodeInstanceId: 'node-instance-1',
          nodePhase: 'executing' as const,
          runId: 'run-1',
        },
      })),
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    await manager.start();
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect(processExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: {
          fault: { code: 'UNKNOWN_OUTCOME', message: 'Execution outcome is unknown.' },
          kind: 'unknown',
        },
      }),
    );
    await manager.stop();
  });

  it('hydrates a claim replay before Start supervision', async () => {
    const scheduler = new ManualScheduler();
    const claimed = { ...startedAuthority(), attemptPhase: 'claimed' as const };
    const verifyAndStart = vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
      fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'unavailable' },
      kind: 'fault',
    }));
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const lifecycle = lifecycleStub({
      claim: vi.fn<RunLifecycle['claim']>(async () => ({
        committedAt: 1,
        cursor: { runId: 'run-1', sequence: 1 },
        kind: 'replayed',
        value: {
          attemptId: 'attempt-1',
          fencingToken: 1,
          nodeInstanceId: 'node-instance-1',
          ordinal: 1,
          runId: 'run-1',
        },
      })),
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [claimable()], next: null },
      })),
      hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => ({
        kind: 'hydrated',
        transactionNow: 2,
        value: { authority: claimed, phase: 'claimed', recovery: 'start' },
      })),
      verifyAndStart,
      writeHandoff,
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    await manager.start();
    await flush();
    expect(verifyAndStart).toHaveBeenCalledOnce();
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_start_failure');
    await manager.stop();
  });

  it('executes only after fresh Start and durably hands off unavailable progression', async () => {
    const scheduler = new ManualScheduler();
    const authority = startedAuthority();
    const invoke = vi.fn<(signal: AbortSignal) => Promise<LifecycleExecuteObservation>>(
      async () => ({
        kind: 'succeeded',
        outputs: [{ name: 'result', payload: { kind: 'json' as const, value: 1 } }],
      }),
    );
    const writeHandoff = vi
      .fn<RunLifecycle['writeHandoff']>()
      .mockRejectedValueOnce(new Error('commit outcome is ambiguous'))
      .mockImplementation(async (request) => ({
        committedAt: 3,
        cursor: { runId: request.authority.runId, sequence: 3 },
        kind: 'replayed',
        value: {
          attemptId: request.authority.attemptId,
          handoffId: request.generatedHandoffId,
          incumbentFencingToken: request.authority.fencingToken,
        },
      }));
    const lifecycle = lifecycleStub({
      claim: vi.fn<RunLifecycle['claim']>(async () => ({
        cursor: { runId: 'run-1', sequence: 1 },
        kind: 'committed',
        transactionNow: 1,
        value: { authority: { ...authority, attemptPhase: 'claimed' }, ordinal: 1 },
      })),
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [claimable()], next: null },
      })),
      processExecuteObservation: vi.fn<RunLifecycle['processExecuteObservation']>(
        async (request) => ({
          authority: request.authority,
          kind: 'requires_progression',
          observation: {
            kind: 'succeeded',
            outputs:
              request.observation.kind === 'succeeded'
                ? request.observation.outputs.map((output, index) => ({
                    name: output.name,
                    outputId: request.generatedOutputIds[index]!,
                    payload: output.payload,
                  }))
                : [],
          },
        }),
      ),
      verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
        cursor: { runId: 'run-1', sequence: 2 },
        kind: 'committed',
        transactionNow: 2,
        value: {
          authority,
          execute: Object.freeze({ invoke }),
          invocation: Object.freeze({
            activationContext: null,
            attempt: {
              activationId: 'activation-1',
              attemptId: 'attempt-1',
              dispatchIdempotencyKey: 'dispatch-1',
              nodeInstanceId: 'node-instance-1',
              nodeKey: 'node-a',
              runId: 'run-1',
            },
            executorConfiguration: null,
            executorConfigurationDigest: authority.executorConfigurationDigest,
            executorContractPin: authority.executorContractPin,
            runInput: null,
          }),
          kind: 'execute',
        },
      })),
      writeHandoff,
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    await manager.start();
    await flush();
    expect(invoke).toHaveBeenCalledOnce();
    scheduler.waits.at(-1)?.resolve();
    await flush();
    expect(writeHandoff).toHaveBeenCalledTimes(2);
    expect(writeHandoff.mock.calls[0]?.[0].generatedHandoffId).toBe(
      writeHandoff.mock.calls[1]?.[0].generatedHandoffId,
    );
    expect(writeHandoff.mock.calls[0]?.[0].idempotencyKey).toBe(
      writeHandoff.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_progression_unavailable');
    expect(manager.state).toBe('running');
    await manager.stop();
  });

  it('durably settles active authority when the renewal wait rejects', async () => {
    const scheduler = new ManualScheduler();
    const authority = startedAuthority();
    const invocation = deferred<LifecycleExecuteObservation>();
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const renewLease = vi.fn<RunLifecycle['renewLease']>(async () => ({
      conflict: { code: 'STALE_FENCE', message: 'stale' },
      kind: 'conflict',
    }));
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim: vi.fn<RunLifecycle['claim']>(async () => ({
            cursor: { runId: 'run-1', sequence: 1 },
            kind: 'committed',
            transactionNow: 1,
            value: { authority: { ...authority, attemptPhase: 'claimed' }, ordinal: 1 },
          })),
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [claimable()], next: null },
          })),
          renewLease,
          verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
            cursor: { runId: 'run-1', sequence: 2 },
            kind: 'committed',
            transactionNow: 2,
            value: {
              authority,
              execute: { invoke: () => invocation.promise },
              invocation: {
                activationContext: null,
                attempt: {
                  activationId: 'activation-1',
                  attemptId: 'attempt-1',
                  dispatchIdempotencyKey: 'dispatch-1',
                  nodeInstanceId: 'node-instance-1',
                  nodeKey: 'node-a',
                  runId: 'run-1',
                },
                executorConfiguration: null,
                executorConfigurationDigest: authority.executorConfigurationDigest,
                executorContractPin: authority.executorContractPin,
                runInput: null,
              },
              kind: 'execute',
            },
          })),
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    await manager.start();
    await flush();
    scheduler.waits.find((wait) => wait.delayMs === 5_000)?.reject(new Error('renew wait failed'));
    await flush();
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_recovery_failure');
    scheduler.runNext();
    await flush();
    scheduler.waits
      .filter((wait) => wait.delayMs === 5_000)
      .at(-1)
      ?.resolve();
    await flush();
    expect(renewLease).toHaveBeenCalledOnce();
    await manager.stop();
    expect(manager.state).toBe('stopped');
  });

  it('treats renewal wait rejection after lane closure as completion', async () => {
    const scheduler = new ManualScheduler();
    const authority = startedAuthority();
    const invocation = deferred<LifecycleExecuteObservation>();
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
      committedHandoff(request),
    );
    const manager = buildRunManager(
      dependenciesFor(
        lifecycleStub({
          claim: vi.fn<RunLifecycle['claim']>(async () => ({
            cursor: { runId: 'run-1', sequence: 1 },
            kind: 'committed',
            transactionNow: 1,
            value: { authority: { ...authority, attemptPhase: 'claimed' }, ordinal: 1 },
          })),
          discover: vi.fn<RunLifecycle['discover']>(async () => ({
            kind: 'page',
            page: { highWatermark: 1, items: [claimable()], next: null },
          })),
          processExecuteObservation: vi.fn<RunLifecycle['processExecuteObservation']>(async () => {
            throw new Error('result processing failed');
          }),
          verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
            cursor: { runId: 'run-1', sequence: 2 },
            kind: 'committed',
            transactionNow: 2,
            value: {
              authority,
              execute: { invoke: () => invocation.promise },
              invocation: {
                activationContext: null,
                attempt: {
                  activationId: 'activation-1',
                  attemptId: 'attempt-1',
                  dispatchIdempotencyKey: 'dispatch-1',
                  nodeInstanceId: 'node-instance-1',
                  nodeKey: 'node-a',
                  runId: 'run-1',
                },
                executorConfiguration: null,
                executorConfigurationDigest: authority.executorConfigurationDigest,
                executorContractPin: authority.executorContractPin,
                runInput: null,
              },
              kind: 'execute',
            },
          })),
          writeHandoff,
        }),
        scheduler,
        {
          loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
            kind: 'loaded',
            planDocument: plan,
          })),
        },
      ),
    );

    await manager.start();
    await flush();
    const renewalWait = scheduler.waits.find((wait) => wait.delayMs === 5_000);
    invocation.resolve({ kind: 'cancelled' });
    await flush();
    renewalWait?.reject(new Error('aborted renewal wait'));
    await flush();
    expect(writeHandoff).toHaveBeenCalledOnce();
    await manager.stop();
    expect(manager.state).toBe('stopped');
  });

  it('hydrates acquisition and maps reconciliation replay to reconciled unknown', async () => {
    const scheduler = new ManualScheduler();
    const authority = unknownAuthority();
    const reconciling = {
      ...authority,
      attemptPhase: 'reconciling' as const,
      expectedAttemptRevision: 3,
    };
    const processReconcile = vi.fn<RunLifecycle['processReconcileObservation']>(async () => ({
      conflict: { code: 'STALE_FENCE', message: 'stale' },
      kind: 'conflict',
    }));
    const lifecycle = lifecycleStub({
      acquire: vi.fn<RunLifecycle['acquire']>(async () => ({
        cursor: { runId: 'run-1', sequence: 1 },
        kind: 'committed',
        transactionNow: 1,
        value: {
          authority,
          evidence: { kind: 'lease_expired' },
          recovery: 'reconcile',
        },
      })),
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [expired()], next: null },
      })),
      hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => ({
        kind: 'hydrated',
        transactionNow: 2,
        value: {
          authority: reconciling,
          phase: 'reconciling',
          recovery: 'reconcile',
        },
      })),
      prepareReconciliation: vi.fn<RunLifecycle['prepareReconciliation']>(async () => ({
        committedAt: 2,
        cursor: { runId: 'run-1', sequence: 2 },
        kind: 'replayed',
        value: {
          attemptId: 'attempt-1',
          attemptPhase: 'reconciling',
          attemptRevision: 3,
          fencingToken: 1,
          managerIncarnationId: 'manager-1',
          nodeInstanceId: 'node-instance-1',
          nodePhase: 'unknown',
          runId: 'run-1',
        },
      })),
      processReconcileObservation: processReconcile,
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    await manager.start();
    await flush();
    expect(processReconcile.mock.calls[0]?.[0].observation).toEqual({
      fault: {
        code: 'UNKNOWN_OUTCOME',
        message: 'Reconciliation outcome is unknown.',
      },
      kind: 'unknown',
    });
    await manager.stop();
  });

  it('hydrates an acquisition replay before recovery', async () => {
    const scheduler = new ManualScheduler();
    const authority = unknownAuthority();
    const acquire = vi.fn<RunLifecycle['acquire']>(async () => ({
      committedAt: 1,
      cursor: { runId: 'run-1', sequence: 1 },
      kind: 'replayed',
      value: {
        attemptId: 'attempt-1',
        nodeInstanceId: 'node-instance-1',
        recovery: 'reconcile',
        runId: 'run-1',
        successorFencingToken: 1,
        successorManagerIncarnationId: 'manager-1',
      },
    }));
    const lifecycle = lifecycleStub({
      acquire,
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [expired()], next: null },
      })),
      hydrateOwnedAuthority: vi
        .fn<RunLifecycle['hydrateOwnedAuthority']>()
        .mockResolvedValueOnce({
          kind: 'hydrated',
          transactionNow: 2,
          value: { authority, phase: 'unknown', recovery: 'reconcile' },
        })
        .mockResolvedValue({
          conflict: { code: 'STALE_FENCE', message: 'stale' },
          kind: 'conflict',
        }),
      prepareReconciliation: vi.fn<RunLifecycle['prepareReconciliation']>(async () => ({
        conflict: { code: 'STALE_FENCE', message: 'stale' },
        kind: 'conflict',
      })),
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    await manager.start();
    await flush();
    expect(acquire).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('recovers owned work, reconciles running, and hands off during drain', async () => {
    const scheduler = new ManualScheduler();
    const unknown = unknownAuthority();
    const reconciling = {
      ...unknown,
      attemptPhase: 'reconciling' as const,
      expectedAttemptRevision: 3,
    };
    const running = {
      ...startedAuthority(),
      expectedAttemptRevision: 4,
      expectedNodeRevision: 2,
      expectedRunRevision: 2,
    };
    const renewed = { ...running, expectedAttemptRevision: 5, leaseExpiresAt: 20_000 };
    const reconcile = vi.fn<(signal: AbortSignal) => Promise<{ readonly kind: 'running' }>>(
      async () => ({ kind: 'running' }),
    );
    let finishHandoff: ((result: LifecycleWriteHandoffResult) => void) | undefined;
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(
      (request) =>
        new Promise((resolve) => {
          finishHandoff = resolve;
          expect(request.reason).toBe('manager_shutdown');
        }),
    );
    const renewLease = vi.fn<RunLifecycle['renewLease']>(async () => ({
      cursor: { runId: 'run-1', sequence: 4 },
      kind: 'committed',
      transactionNow: 4,
      value: { authority: renewed, lastHeartbeatAt: 4 },
    }));
    const lifecycle = lifecycleStub({
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [renewable()], next: null },
      })),
      hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => ({
        kind: 'hydrated',
        transactionNow: 1,
        value: { authority: unknown, phase: 'unknown', recovery: 'reconcile' },
      })),
      prepareReconciliation: vi.fn<RunLifecycle['prepareReconciliation']>(async () => ({
        cursor: { runId: 'run-1', sequence: 2 },
        kind: 'committed',
        transactionNow: 2,
        value: {
          authority: reconciling,
          invocation: {
            activationContext: null,
            attempt: {
              activationId: 'activation-1',
              attemptId: 'attempt-1',
              dispatchIdempotencyKey: 'dispatch-1',
              nodeInstanceId: 'node-instance-1',
              nodeKey: 'node-a',
              runId: 'run-1',
            },
            executorConfiguration: null,
            executorConfigurationDigest: unknown.executorConfigurationDigest,
            executorContractPin: unknown.executorContractPin,
            runInput: null,
          },
          kind: 'reconcile',
          reconcile: { invoke: reconcile },
        },
      })),
      processReconcileObservation: vi.fn<RunLifecycle['processReconcileObservation']>(async () => ({
        cursor: { runId: 'run-1', sequence: 3 },
        kind: 'committed',
        transactionNow: 3,
        value: { authority: running, observation: 'running' },
      })),
      renewLease,
      writeHandoff,
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    await manager.start();
    await flush();
    expect(reconcile).toHaveBeenCalledOnce();
    scheduler.waits[0]?.resolve();
    await flush();
    expect(renewLease).toHaveBeenCalledOnce();
    const timedStop = manager.stop({ timeoutMs: 1 });
    await flush();
    scheduler.waits.find((wait) => wait.delayMs === 1)?.resolve();
    await flush();
    finishHandoff?.({
      cursor: { runId: 'run-1', sequence: 5 },
      kind: 'committed',
      transactionNow: 5,
      value: {
        attemptId: 'attempt-1',
        handoffId: 'handoff-1',
        incumbentFencingToken: 1,
      },
    });
    await expect(timedStop).rejects.toThrow('RunManager stop timed out');
    await manager.stop();
    expect(writeHandoff.mock.calls[0]?.[0]).toMatchObject({
      authority: { attemptPhase: 'start_committed', expectedAttemptRevision: 5 },
      reason: 'manager_shutdown',
    });
    expect(manager.state).toBe('stopped');
  });

  it('repeats reconciliation through the scheduler from running to succeeded', async () => {
    const scheduler = new ManualScheduler();
    const unknown = unknownAuthority();
    const reconciling = {
      ...unknown,
      attemptPhase: 'reconciling' as const,
      expectedAttemptRevision: 3,
    };
    const running = {
      ...startedAuthority(),
      expectedAttemptRevision: 4,
      expectedNodeRevision: 2,
      expectedRunRevision: 2,
    };
    const reconcile = vi
      .fn<
        (
          signal: AbortSignal,
        ) => Promise<
          { readonly kind: 'running' } | { readonly kind: 'succeeded'; readonly outputs: [] }
        >
      >()
      .mockResolvedValueOnce({ kind: 'running' })
      .mockResolvedValue({ kind: 'succeeded', outputs: [] });
    const processReconcile = vi
      .fn<RunLifecycle['processReconcileObservation']>()
      .mockResolvedValueOnce({
        cursor: { runId: 'run-1', sequence: 3 },
        kind: 'committed',
        transactionNow: 3,
        value: { authority: running, observation: 'running' },
      })
      .mockImplementation(async () => ({
        authority: reconciling,
        kind: 'requires_progression',
        observation: { kind: 'succeeded', outputs: [] },
      }));
    const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) => ({
      cursor: { runId: 'run-1', sequence: 6 },
      kind: 'committed',
      transactionNow: 6,
      value: {
        attemptId: request.authority.attemptId,
        handoffId: request.generatedHandoffId,
        incumbentFencingToken: request.authority.fencingToken,
      },
    }));
    const lifecycle = lifecycleStub({
      discover: vi.fn<RunLifecycle['discover']>(async () => ({
        kind: 'page',
        page: { highWatermark: 1, items: [renewable()], next: null },
      })),
      hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => ({
        kind: 'hydrated',
        transactionNow: 1,
        value: { authority: unknown, phase: 'unknown', recovery: 'reconcile' },
      })),
      prepareReconciliation: vi.fn<RunLifecycle['prepareReconciliation']>(async () => ({
        cursor: { runId: 'run-1', sequence: 2 },
        kind: 'committed',
        transactionNow: 2,
        value: {
          authority: reconciling,
          invocation: {
            activationContext: null,
            attempt: {
              activationId: 'activation-1',
              attemptId: 'attempt-1',
              dispatchIdempotencyKey: 'dispatch-1',
              nodeInstanceId: 'node-instance-1',
              nodeKey: 'node-a',
              runId: 'run-1',
            },
            executorConfiguration: null,
            executorConfigurationDigest: unknown.executorConfigurationDigest,
            executorContractPin: unknown.executorContractPin,
            runInput: null,
          },
          kind: 'reconcile',
          reconcile: { invoke: reconcile },
        },
      })),
      processExecuteObservation: vi.fn<RunLifecycle['processExecuteObservation']>(async () => ({
        cursor: { runId: 'run-1', sequence: 4 },
        kind: 'committed',
        transactionNow: 4,
        value: { authority: unknown, observation: 'unknown' },
      })),
      processReconcileObservation: processReconcile,
      writeHandoff,
    });
    const manager = buildRunManager(
      dependenciesFor(lifecycle, scheduler, {
        loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
          kind: 'loaded',
          planDocument: plan,
        })),
      }),
    );

    await manager.start();
    await flush();
    scheduler.waits.find((wait) => wait.delayMs === 100)?.resolve();
    await flush();
    await flush();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(writeHandoff.mock.calls[0]?.[0].reason).toBe('manager_progression_unavailable');
    await manager.stop();
  });

  it('releases failed recovery hydration both before and during quiesce', async () => {
    const build = (
      scheduler: ManualScheduler,
      discover: RunLifecycle['discover'],
      hydrateOwnedAuthority: RunLifecycle['hydrateOwnedAuthority'],
      claim: RunLifecycle['claim'],
      writeHandoff: RunLifecycle['writeHandoff'],
    ) =>
      buildRunManager(
        dependenciesFor(
          lifecycleStub({
            claim,
            discover,
            hydrateOwnedAuthority,
            writeHandoff,
          }),
          scheduler,
          {
            loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
              kind: 'loaded',
              planDocument: plan,
            })),
          },
        ),
        {
          concurrency: {
            maximumConcurrentExecutions: 1,
            maximumConcurrentExecutionsPerExecutor: 1,
          },
        },
      );
    const conflict: Awaited<ReturnType<RunLifecycle['hydrateOwnedAuthority']>> = {
      conflict: { code: 'STALE_FENCE', message: 'stale' },
      kind: 'conflict',
    };

    const immediateScheduler = new ManualScheduler();
    const immediateClaim = vi.fn<RunLifecycle['claim']>(async () => ({
      conflict: { code: 'STALE_FENCE', message: 'stale' },
      kind: 'conflict',
    }));
    const immediateHandoff = vi.fn<RunLifecycle['writeHandoff']>();
    const immediate = build(
      immediateScheduler,
      vi
        .fn<RunLifecycle['discover']>()
        .mockResolvedValueOnce({
          kind: 'page',
          page: { highWatermark: 1, items: [renewable()], next: null },
        })
        .mockResolvedValue({
          kind: 'page',
          page: { highWatermark: 1, items: [claimable()], next: null },
        }),
      vi.fn<RunLifecycle['hydrateOwnedAuthority']>(async () => conflict),
      immediateClaim,
      immediateHandoff,
    );
    await immediate.start();
    expect(immediateClaim).toHaveBeenCalledOnce();
    expect(immediateHandoff).not.toHaveBeenCalled();
    await immediate.stop();
    expect(immediate.state).toBe('stopped');

    const delayedScheduler = new ManualScheduler();
    const hydration = deferred<Awaited<ReturnType<RunLifecycle['hydrateOwnedAuthority']>>>();
    const hydrationStarted = deferred<void>();
    const delayedClaim = vi.fn<RunLifecycle['claim']>(async () => ({
      conflict: { code: 'STALE_FENCE', message: 'stale' },
      kind: 'conflict',
    }));
    const delayedHandoff = vi.fn<RunLifecycle['writeHandoff']>();
    const delayed = build(
      delayedScheduler,
      vi
        .fn<RunLifecycle['discover']>()
        .mockResolvedValueOnce({
          kind: 'page',
          page: { highWatermark: 1, items: [renewable()], next: null },
        })
        .mockResolvedValue({
          kind: 'page',
          page: { highWatermark: 1, items: [claimable()], next: null },
        }),
      () => {
        hydrationStarted.resolve();
        return hydration.promise;
      },
      delayedClaim,
      delayedHandoff,
    );
    const starting = delayed.start();
    await hydrationStarted.promise;
    const stopping = delayed.stop();
    hydration.resolve(conflict);
    await Promise.all([starting, stopping]);
    expect(delayed.state).toBe('stopped');
    await delayed.start();
    expect(delayedClaim).toHaveBeenCalledOnce();
    expect(delayedHandoff).not.toHaveBeenCalled();
    await delayed.stop();
  });

  it('hands off acquired authority whose phase contradicts its recovery route', async () => {
    const recoveryRoutes: readonly ('start' | 'reconcile')[] = ['start', 'reconcile'];
    await Promise.all(
      recoveryRoutes.map(async (recovery) => {
        const scheduler = new ManualScheduler();
        const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
          committedHandoff(request),
        );
        const manager = buildRunManager(
          dependenciesFor(
            lifecycleStub({
              acquire: vi.fn<RunLifecycle['acquire']>(async () => ({
                cursor: { runId: 'run-1', sequence: 1 },
                kind: 'committed',
                transactionNow: 1,
                value: {
                  authority: startedAuthority(),
                  evidence: { kind: 'lease_expired' },
                  recovery,
                },
              })),
              discover: vi.fn<RunLifecycle['discover']>(async () => ({
                kind: 'page',
                page: { highWatermark: 1, items: [expired()], next: null },
              })),
              writeHandoff,
            }),
            scheduler,
            {
              loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
                kind: 'loaded',
                planDocument: plan,
              })),
            },
          ),
        );

        await manager.start();
        await flush();
        expect(writeHandoff.mock.calls[0]?.[0].reason).toBe(
          recovery === 'start' ? 'manager_start_failure' : 'manager_recovery_failure',
        );
        await manager.stop();
      }),
    );
  });

  it('durably settles direct running, stale, and faulted executor observation processing', async () => {
    const authority = startedAuthority();
    const outcomes: readonly LifecycleProcessObservationResult[] = [
      {
        cursor: { runId: 'run-1', sequence: 3 },
        kind: 'committed',
        transactionNow: 3,
        value: { authority, observation: 'running' },
      },
      { conflict: { code: 'STALE_FENCE', message: 'stale' }, kind: 'conflict' },
      {
        fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'processing unavailable' },
        kind: 'fault',
      },
    ];

    const settlements = await Promise.all(
      outcomes.map(async (outcome) => {
        const scheduler = new ManualScheduler();
        const handoffSettlement =
          outcome.kind === 'committed' ? deferred<LifecycleWriteHandoffResult>() : null;
        const claim = vi.fn<RunLifecycle['claim']>(async () => ({
          cursor: { runId: 'run-1', sequence: 1 },
          kind: 'committed',
          transactionNow: 1,
          value: { authority: { ...authority, attemptPhase: 'claimed' }, ordinal: 1 },
        }));
        const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) => {
          if (handoffSettlement !== null) return handoffSettlement.promise;
          return committedHandoff(request);
        });
        const manager = buildRunManager(
          dependenciesFor(
            lifecycleStub({
              claim,
              discover: vi.fn<RunLifecycle['discover']>(async () => ({
                kind: 'page',
                page: { highWatermark: 1, items: [claimable()], next: null },
              })),
              processExecuteObservation: vi.fn<RunLifecycle['processExecuteObservation']>(
                async () => outcome,
              ),
              verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
                cursor: { runId: 'run-1', sequence: 2 },
                kind: 'committed',
                transactionNow: 2,
                value: {
                  authority,
                  execute: { invoke: async () => ({ kind: 'cancelled' }) },
                  invocation: {
                    activationContext: null,
                    attempt: {
                      activationId: 'activation-1',
                      attemptId: 'attempt-1',
                      dispatchIdempotencyKey: 'dispatch-1',
                      nodeInstanceId: 'node-instance-1',
                      nodeKey: 'node-a',
                      runId: 'run-1',
                    },
                    executorConfiguration: null,
                    executorConfigurationDigest: authority.executorConfigurationDigest,
                    executorContractPin: authority.executorContractPin,
                    runInput: null,
                  },
                  kind: 'execute',
                },
              })),
              writeHandoff,
            }),
            scheduler,
            {
              loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
                kind: 'loaded',
                planDocument: plan,
              })),
            },
          ),
          {
            concurrency: {
              maximumConcurrentExecutions: 1,
              maximumConcurrentExecutionsPerExecutor: 1,
            },
          },
        );

        await manager.start();
        await flush();
        if (handoffSettlement !== null) {
          scheduler.runNext();
          await flush();
        }
        const claimCountBeforeSettlement = claim.mock.calls.length;
        const handoffRequest = writeHandoff.mock.calls[0]?.[0];
        if (handoffSettlement !== null && handoffRequest !== undefined) {
          handoffSettlement.resolve(committedHandoff(handoffRequest));
          await flush();
        }
        await manager.stop();
        return {
          claimCountBeforeSettlement,
          handoffCount: writeHandoff.mock.calls.length,
          handoffReason: writeHandoff.mock.calls[0]?.[0].reason ?? null,
          outcome: outcome.kind,
        };
      }),
    );
    expect(settlements).toEqual([
      {
        claimCountBeforeSettlement: 1,
        handoffCount: 1,
        handoffReason: 'manager_recovery_failure',
        outcome: 'committed',
      },
      {
        claimCountBeforeSettlement: 1,
        handoffCount: 0,
        handoffReason: null,
        outcome: 'conflict',
      },
      {
        claimCountBeforeSettlement: 1,
        handoffCount: 1,
        handoffReason: 'manager_recovery_failure',
        outcome: 'fault',
      },
    ]);
  });

  it('settles stale and faulted Start replay hydration without execution', async () => {
    const hydrationOutcomes: readonly Awaited<ReturnType<RunLifecycle['hydrateOwnedAuthority']>>[] =
      [
        { conflict: { code: 'STALE_FENCE', message: 'stale' }, kind: 'conflict' },
        {
          fault: { code: 'EXECUTOR_UNAVAILABLE', message: 'hydration unavailable' },
          kind: 'fault',
        },
      ];
    const settlements = await Promise.all(
      hydrationOutcomes.map(async (hydrationOutcome) => {
        const scheduler = new ManualScheduler();
        const processExecute = vi.fn<RunLifecycle['processExecuteObservation']>();
        const writeHandoff = vi.fn<RunLifecycle['writeHandoff']>(async (request) =>
          committedHandoff(request),
        );
        const manager = buildRunManager(
          dependenciesFor(
            lifecycleStub({
              claim: vi.fn<RunLifecycle['claim']>(async () => ({
                cursor: { runId: 'run-1', sequence: 1 },
                kind: 'committed',
                transactionNow: 1,
                value: {
                  authority: { ...startedAuthority(), attemptPhase: 'claimed' },
                  ordinal: 1,
                },
              })),
              discover: vi.fn<RunLifecycle['discover']>(async () => ({
                kind: 'page',
                page: { highWatermark: 1, items: [claimable()], next: null },
              })),
              hydrateOwnedAuthority: vi.fn<RunLifecycle['hydrateOwnedAuthority']>(
                async () => hydrationOutcome,
              ),
              processExecuteObservation: processExecute,
              verifyAndStart: vi.fn<RunLifecycle['verifyAndStart']>(async () => ({
                committedAt: 2,
                cursor: { runId: 'run-1', sequence: 2 },
                kind: 'replayed',
                value: {
                  attemptId: 'attempt-1',
                  attemptPhase: 'start_committed',
                  attemptRevision: 2,
                  fencingToken: 1,
                  managerIncarnationId: 'manager-1',
                  nodeInstanceId: 'node-instance-1',
                  nodePhase: 'executing',
                  runId: 'run-1',
                },
              })),
              writeHandoff,
            }),
            scheduler,
            {
              loadExact: vi.fn<ExecutionPlanSource['loadExact']>(async () => ({
                kind: 'loaded',
                planDocument: plan,
              })),
            },
          ),
        );

        await manager.start();
        await flush();
        await manager.stop();
        return {
          processExecuteCount: processExecute.mock.calls.length,
          handoffReason: writeHandoff.mock.calls[0]?.[0].reason ?? null,
          outcome: hydrationOutcome.kind,
        };
      }),
    );
    expect(settlements).toEqual([
      { processExecuteCount: 0, handoffReason: null, outcome: 'conflict' },
      {
        handoffReason: 'manager_recovery_failure',
        outcome: 'fault',
        processExecuteCount: 0,
      },
    ]);
  });
});
