import type {
  LifecycleAttemptAuthority,
  LifecycleClaimedExecutionAuthority,
  LifecycleDiscoveryCandidate,
  LifecycleDiscoveryCursor,
  LifecycleDiscoveryKind,
  LifecycleExecuteObservation,
  LifecycleHydrateOwnedAuthorityResult,
  LifecyclePreparedExecuteCall,
  LifecyclePreparedReconcileCall,
  LifecycleReconcileObservation,
  LifecycleReconcilingExecutionAuthority,
  LifecycleStartedExecutionAuthority,
  LifecycleUnknownExecutionAuthority,
  RunLifecycle,
} from '../lifecycle/index.js';
import { executorObservationNormalization } from '../lifecycle/index.js';
import {
  snapshotLeasePolicy,
  snapshotProcessLocalConcurrencyPolicy,
  snapshotRetryPolicy,
  snapshotRunExecutionPlanDocument,
} from '../policy/index.js';
import type {
  ExecutionPlanSource,
  LocalClock,
  LocalScheduler,
  ManagerIdSource,
  ScheduledTask,
} from '../ports/index.js';
import type {
  LeasePolicy,
  ProcessLocalConcurrencyPolicy,
  RetryPolicy,
  RunExecutionPlanDocument,
  RunExecutionPlanExecutorBinding,
} from '../spec/index.js';

type RunManagerSupervisorState = 'stopped' | 'starting' | 'running' | 'quiescing' | 'draining';

interface RunManagerSupervisorDependencies {
  readonly lifecycle: RunLifecycle;
  readonly plans: ExecutionPlanSource;
  readonly ids: ManagerIdSource;
  readonly clock: LocalClock;
  readonly scheduler: LocalScheduler;
}

interface RunManagerSupervisorOptions {
  readonly ownerLabel?: string;
  readonly pollIntervalMs?: number;
  readonly lease?: LeasePolicy;
  readonly concurrency?: ProcessLocalConcurrencyPolicy;
  readonly discoveryPageSize?: number;
  readonly pollRetry?: RetryPolicy;
}

interface StopRunManagerSupervisorOptions {
  readonly timeoutMs?: number;
}

interface RunManagerSupervisor {
  readonly state: RunManagerSupervisorState;
  readonly managerIncarnationId: string | null;
  start(): Promise<void>;
  stop(options?: StopRunManagerSupervisorOptions): Promise<void>;
}

interface SupervisorConfiguration {
  readonly ownerLabel: string;
  readonly pollIntervalMs: number;
  readonly lease: LeasePolicy;
  readonly concurrency: ProcessLocalConcurrencyPolicy;
  readonly discoveryPageSize: number;
  readonly pollRetry: RetryPolicy;
}

interface CapacityReservation {
  readonly adapterId: string;
  released: boolean;
}

interface AuthorityLane {
  authority: LifecycleAttemptAuthority;
  readonly planDocument: RunExecutionPlanDocument;
  readonly reservation: CapacityReservation;
  readonly invocationAbort: AbortController;
  readonly handoffAbort: AbortController;
  operation: Promise<void>;
  renewal: Promise<void> | null;
  renewalPaused: boolean;
  reconciliationAttempts: number;
  reconciliationTask: Promise<void> | null;
  closed: boolean;
}

interface Generation {
  readonly incarnationId: string;
  readonly abort: AbortController;
  pollTask: ScheduledTask | null;
  pollFailures: number;
}

const discoveryKinds: readonly LifecycleDiscoveryKind[] = Object.freeze([
  'handoff_attempt',
  'expired_attempt',
  'renewable_attempt',
  'claimable_node',
  'cancellation_run',
  'progressable_run',
]);

const positiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const selected = value ?? fallback;
  if (
    typeof selected !== 'number' ||
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > maximum
  ) {
    throw new RangeError('RunManager coordination value is invalid.');
  }
  return selected;
};

const boundedOwnerLabel = (value: unknown): string => {
  const selected = value ?? 'run-manager';
  if (
    typeof selected !== 'string' ||
    selected.length === 0 ||
    Buffer.byteLength(selected, 'utf8') > 256
  ) {
    throw new TypeError('RunManager owner label is invalid.');
  }
  return selected;
};

const snapshotConfiguration = (
  options: RunManagerSupervisorOptions | undefined,
): SupervisorConfiguration => {
  const source = options ?? {};
  return Object.freeze({
    concurrency: snapshotProcessLocalConcurrencyPolicy(
      source.concurrency ?? {
        maximumConcurrentExecutions: 16,
        maximumConcurrentExecutionsPerExecutor: 4,
      },
    ),
    discoveryPageSize: positiveInteger(source.discoveryPageSize, 100, 1_024),
    lease: snapshotLeasePolicy(
      source.lease ?? { heartbeatIntervalMs: 5_000, leaseDurationMs: 30_000 },
    ),
    ownerLabel: boundedOwnerLabel(source.ownerLabel),
    pollIntervalMs: positiveInteger(source.pollIntervalMs, 250, 86_400_000),
    pollRetry: snapshotRetryPolicy(
      source.pollRetry ?? {
        backoffMultiplier: 2,
        initialBackoffMs: 250,
        maximumAttempts: 4,
        maximumBackoffMs: 5_000,
      },
    ),
  });
};

const findBinding = (
  planDocument: RunExecutionPlanDocument,
  nodeKey: string,
): RunExecutionPlanExecutorBinding | null => {
  const matches = planDocument.executorBindings.filter((binding) => binding.nodeKey === nodeKey);
  return matches.length === 1 ? matches[0]! : null;
};

const isStaleResult = (result: {
  readonly kind: string;
  readonly conflict?: { readonly code: string };
  readonly fault?: { readonly code: string };
}): boolean =>
  (result.kind === 'conflict' &&
    (result.conflict?.code === 'STALE_FENCE' ||
      result.conflict?.code === 'INVALID_STATE' ||
      result.conflict?.code === 'NOT_FOUND')) ||
  (result.kind === 'fault' && result.fault?.code === 'NOT_FOUND');

const directUnknown = (): LifecycleExecuteObservation =>
  Object.freeze({
    fault: Object.freeze({
      code: 'UNKNOWN_OUTCOME',
      message: 'Execution outcome is unknown.',
    }),
    kind: 'unknown',
  });

const reconciledUnknown = () =>
  Object.freeze({
    fault: Object.freeze({
      code: 'UNKNOWN_OUTCOME' as const,
      message: 'Reconciliation outcome is unknown.',
    }),
    kind: 'unknown' as const,
  });

const isClaimedAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleClaimedExecutionAuthority =>
  authority.attemptPhase === 'claimed' && authority.nodePhase === 'executing';

const isStartedAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleStartedExecutionAuthority =>
  authority.attemptPhase === 'start_committed' && authority.nodePhase === 'executing';

const isUnknownAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleUnknownExecutionAuthority =>
  authority.attemptPhase === 'unknown' && authority.nodePhase === 'unknown';

const isReconcilingAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleReconcilingExecutionAuthority =>
  authority.attemptPhase === 'reconciling' && authority.nodePhase === 'unknown';

class InternalRunManagerSupervisor implements RunManagerSupervisor {
  #state: RunManagerSupervisorState = 'stopped';
  #generation: Generation | null = null;
  #startOperation: Promise<void> | null = null;
  #stopOperation: Promise<void> | null = null;
  readonly #configuration: SupervisorConfiguration;
  readonly #lanes = new Map<string, AuthorityLane>();
  readonly #adapterUse = new Map<string, number>();
  readonly #candidateOperations = new Set<Promise<void>>();
  #totalUse = 0;
  #drained: Promise<void> | null = null;
  #resolveDrained: (() => void) | null = null;

  constructor(
    readonly dependencies: RunManagerSupervisorDependencies,
    options?: RunManagerSupervisorOptions,
  ) {
    this.#configuration = snapshotConfiguration(options);
    Object.freeze(dependencies);
  }

  get state(): RunManagerSupervisorState {
    return this.#state;
  }

  get managerIncarnationId(): string | null {
    return this.#generation?.incarnationId ?? null;
  }

  start(): Promise<void> {
    if (this.#state === 'running') return Promise.resolve();
    if (this.#state === 'starting') return this.#startOperation!;
    if (this.#state !== 'stopped') return this.#stopOperation ?? Promise.resolve();

    this.#state = 'starting';
    const generation: Generation = {
      abort: new AbortController(),
      incarnationId: this.dependencies.ids.nextManagerIncarnationId(),
      pollTask: null,
      pollFailures: 0,
    };
    this.#generation = generation;
    const operation = this.#startGeneration(generation);
    this.#startOperation = operation;
    return operation;
  }

  stop(options?: StopRunManagerSupervisorOptions): Promise<void> {
    if (this.#state === 'stopped') return Promise.resolve();
    if (this.#stopOperation === null) {
      this.#stopOperation = this.#stopGeneration();
    }
    const timeoutMs = options?.timeoutMs;
    if (timeoutMs === undefined) return this.#stopOperation;
    positiveInteger(timeoutMs, timeoutMs, 86_400_000);
    return this.#withStopTimeout(this.#stopOperation, timeoutMs);
  }

  async #startGeneration(generation: Generation): Promise<void> {
    try {
      await this.#scan(generation, true);
      if (this.#generation !== generation || this.#state !== 'starting') return;
      this.#state = 'running';
      await this.#scan(generation, false);
      this.#schedulePoll(generation);
    } catch (error) {
      await this.#handoffAll('manager_start_failure');
      if (this.#lanes.size === 0) {
        this.#finishStopped(generation);
      }
      throw error;
    } finally {
      this.#startOperation = null;
    }
  }

  async #stopGeneration(): Promise<void> {
    const generation = this.#generation;
    if (generation === null) return;
    this.#state = 'quiescing';
    generation.pollTask?.cancel();
    generation.pollTask = null;
    await Promise.all([...this.#candidateOperations]);
    this.#state = 'draining';
    if (this.#lanes.size === 0) {
      this.#finishStopped(generation);
      return;
    }
    this.#drained = new Promise((resolve) => {
      this.#resolveDrained = resolve;
    });
    await this.#drained;
  }

  async #withStopTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const stopped = operation.then(() => 'stopped' as const);
    const timeout = this.dependencies.scheduler
      .wait(timeoutMs, controller.signal)
      .then(() => 'timeout' as const);
    try {
      const outcome = await Promise.race([stopped, timeout]);
      if (outcome === 'timeout' && !controller.signal.aborted && this.#state !== 'stopped') {
        await this.#settleTimedOutDrain();
        throw new Error('RunManager stop timed out after durable authority settlement.');
      }
    } finally {
      controller.abort();
    }
  }

  async #settleTimedOutDrain(): Promise<void> {
    await this.#handoffAll('manager_shutdown');
  }

  #isStopping(): boolean {
    return this.#state === 'quiescing' || this.#state === 'draining';
  }

  #finishStopped(generation: Generation): void {
    if (this.#generation !== generation || this.#lanes.size !== 0) return;
    generation.pollTask?.cancel();
    generation.abort.abort();
    this.#generation = null;
    this.#state = 'stopped';
    this.#stopOperation = null;
    this.#resolveDrained?.();
    this.#resolveDrained = null;
    this.#drained = null;
  }

  #schedulePoll(generation: Generation): void {
    if (this.#state !== 'running' || this.#generation !== generation) return;
    generation.pollTask = this.dependencies.scheduler.enqueue(() => {
      void this.#poll(generation).catch(() => undefined);
    });
  }

  async #poll(generation: Generation): Promise<void> {
    if (this.#state !== 'running' || this.#generation !== generation) return;
    try {
      await this.#scan(generation, false);
    } catch {
      await this.#handlePollFailure(generation);
      return;
    }
    if (this.#state !== 'running' || this.#generation !== generation) return;
    generation.pollFailures = 0;
    try {
      await this.dependencies.scheduler.wait(
        this.#configuration.pollIntervalMs,
        generation.abort.signal,
      );
    } catch {
      await this.#handlePollFailure(generation);
      return;
    }
    this.#schedulePoll(generation);
  }

  async #handlePollFailure(generation: Generation): Promise<void> {
    if (this.#generation !== generation || this.#state !== 'running') return;
    generation.pollFailures += 1;
    if (generation.pollFailures >= this.#configuration.pollRetry.maximumAttempts) {
      this.#state = 'quiescing';
      generation.pollTask?.cancel();
      this.#state = 'draining';
      await this.#handoffAll('manager_recovery_failure');
      if (this.#lanes.size === 0) this.#finishStopped(generation);
      return;
    }
    const exponent = generation.pollFailures - 1;
    const delay = Math.min(
      this.#configuration.pollRetry.initialBackoffMs *
        this.#configuration.pollRetry.backoffMultiplier ** exponent,
      this.#configuration.pollRetry.maximumBackoffMs,
    );
    try {
      await this.dependencies.scheduler.wait(delay, generation.abort.signal);
    } catch {
      if (!generation.abort.signal.aborted) await this.#handlePollFailure(generation);
      return;
    }
    this.#schedulePoll(generation);
  }

  async #scan(generation: Generation, recoveryOnly: boolean): Promise<void> {
    await this.#scanPage(generation, recoveryOnly, null);
  }

  async #scanPage(
    generation: Generation,
    recoveryOnly: boolean,
    cursor: LifecycleDiscoveryCursor | null,
  ): Promise<void> {
    const result = await this.dependencies.lifecycle.discover({
      kinds: discoveryKinds,
      limit: this.#configuration.discoveryPageSize,
      renewal: {
        leasePolicy: this.#configuration.lease,
        managerIncarnationId: generation.incarnationId,
      },
      scan: cursor === null ? { kind: 'start' } : { cursor, kind: 'continue' },
    });
    if (result.kind !== 'page') throw new Error('RunManager discovery failed.');
    await this.#processCandidates(result.page.items, generation, recoveryOnly, 0);
    if (result.page.next !== null && this.#generation === generation) {
      await this.#scanPage(generation, recoveryOnly, result.page.next);
    }
  }

  async #processCandidates(
    candidates: readonly LifecycleDiscoveryCandidate[],
    generation: Generation,
    recoveryOnly: boolean,
    index: number,
  ): Promise<void> {
    const candidate = candidates[index];
    if (candidate === undefined || this.#generation !== generation) return;
    let operation: Promise<void> | null = null;
    if (candidate.kind === 'renewable_attempt') {
      operation = this.#recoverOwned(candidate, generation);
    } else if (candidate.kind === 'expired_attempt' || candidate.kind === 'handoff_attempt') {
      operation = this.#acquire(candidate, generation);
    } else if (!recoveryOnly && candidate.kind === 'claimable_node') {
      operation = this.#claim(candidate, generation);
    }
    if (operation !== null) {
      this.#candidateOperations.add(operation);
      try {
        await operation;
      } finally {
        this.#candidateOperations.delete(operation);
      }
    }
    await this.#processCandidates(candidates, generation, recoveryOnly, index + 1);
  }

  #candidateAllowed(generation: Generation, claim: boolean): boolean {
    if (this.#generation !== generation) return false;
    return claim
      ? this.#state === 'running'
      : this.#state === 'starting' || this.#state === 'running';
  }

  async #loadPlan(
    candidate: LifecycleDiscoveryCandidate & { readonly node: { readonly nodeKey: string } },
    generation: Generation,
    claim: boolean,
  ): Promise<{
    readonly planDocument: RunExecutionPlanDocument;
    readonly binding: RunExecutionPlanExecutorBinding;
  } | null> {
    const loaded = await this.dependencies.plans.loadExact(candidate.run.planPin);
    if (!this.#candidateAllowed(generation, claim)) return null;
    if (loaded.kind !== 'loaded') return null;
    let planDocument: RunExecutionPlanDocument;
    try {
      planDocument = snapshotRunExecutionPlanDocument(loaded.planDocument);
    } catch {
      return null;
    }
    const binding = findBinding(planDocument, candidate.node.nodeKey);
    return binding === null ? null : { binding, planDocument };
  }

  #reserve(adapterId: string): CapacityReservation | null {
    const perAdapter = this.#adapterUse.get(adapterId) ?? 0;
    if (
      this.#totalUse >= this.#configuration.concurrency.maximumConcurrentExecutions ||
      perAdapter >= this.#configuration.concurrency.maximumConcurrentExecutionsPerExecutor
    ) {
      return null;
    }
    this.#totalUse += 1;
    this.#adapterUse.set(adapterId, perAdapter + 1);
    return { adapterId, released: false };
  }

  #release(reservation: CapacityReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    this.#totalUse -= 1;
    const remaining = (this.#adapterUse.get(reservation.adapterId) ?? 1) - 1;
    if (remaining === 0) this.#adapterUse.delete(reservation.adapterId);
    else this.#adapterUse.set(reservation.adapterId, remaining);
  }

  async #settleHydratedAuthority(
    hydrated: LifecycleHydrateOwnedAuthorityResult,
    planDocument: RunExecutionPlanDocument,
    reservation: CapacityReservation,
  ): Promise<void> {
    if (hydrated.kind !== 'hydrated') {
      this.#release(reservation);
      return;
    }
    const lane = this.#createLane(hydrated.value.authority, planDocument, reservation);
    await this.#handoff(lane, 'manager_shutdown');
  }

  async #settleCommittedAuthority(
    authority: LifecycleAttemptAuthority,
    planDocument: RunExecutionPlanDocument,
    reservation: CapacityReservation,
  ): Promise<void> {
    const lane = this.#createLane(authority, planDocument, reservation);
    await this.#handoff(lane, 'manager_shutdown');
  }

  async #claim(
    candidate: Extract<LifecycleDiscoveryCandidate, { readonly kind: 'claimable_node' }>,
    generation: Generation,
  ): Promise<void> {
    if (!this.#candidateAllowed(generation, true)) return;
    const loaded = await this.#loadPlan(candidate, generation, true);
    if (loaded === null) return;
    const reservation = this.#reserve(loaded.binding.executor.adapterId);
    if (reservation === null) return;
    const attemptId = this.dependencies.ids.nextAttemptId();
    const result = await this.dependencies.lifecycle.claim({
      candidate,
      generatedAttemptId: attemptId,
      generatedDispatchIdempotencyKey:
        this.dependencies.ids.nextLifecycleIdempotencyKey('verify_and_start'),
      idempotencyKey: this.dependencies.ids.nextLifecycleIdempotencyKey('claim'),
      leasePolicy: this.#configuration.lease,
      managerIncarnationId: generation.incarnationId,
      ownerLabel: this.#configuration.ownerLabel,
      planDocument: loaded.planDocument,
    });
    if (!this.#candidateAllowed(generation, true)) {
      if (result.kind === 'committed') {
        await this.#settleCommittedAuthority(
          result.value.authority,
          loaded.planDocument,
          reservation,
        );
      } else if (result.kind === 'replayed') {
        const hydrated = await this.dependencies.lifecycle.hydrateOwnedAuthority({
          attemptId: result.value.attemptId,
          expectedAttemptFence: result.value.fencingToken,
          expectedManagerIncarnationId: generation.incarnationId,
          expectedPhase: 'claimed',
          nodeInstanceId: result.value.nodeInstanceId,
          runId: result.value.runId,
        });
        await this.#settleHydratedAuthority(hydrated, loaded.planDocument, reservation);
      } else {
        this.#release(reservation);
      }
      return;
    }
    if (result.kind === 'committed') {
      const lane = this.#createLane(result.value.authority, loaded.planDocument, reservation);
      this.#ownLaneTask(lane, this.#startClaimed(lane));
      return;
    }
    if (result.kind === 'replayed') {
      const hydrated = await this.dependencies.lifecycle.hydrateOwnedAuthority({
        attemptId: result.value.attemptId,
        expectedAttemptFence: result.value.fencingToken,
        expectedManagerIncarnationId: generation.incarnationId,
        expectedPhase: 'claimed',
        nodeInstanceId: result.value.nodeInstanceId,
        runId: result.value.runId,
      });
      if (!this.#candidateAllowed(generation, true)) {
        await this.#settleHydratedAuthority(hydrated, loaded.planDocument, reservation);
        return;
      }
      if (hydrated.kind === 'hydrated') {
        const lane = this.#createLane(hydrated.value.authority, loaded.planDocument, reservation);
        this.#ownLaneTask(lane, this.#startClaimed(lane));
        return;
      }
    }
    this.#release(reservation);
  }

  async #recoverOwned(
    candidate: Extract<LifecycleDiscoveryCandidate, { readonly kind: 'renewable_attempt' }>,
    generation: Generation,
  ): Promise<void> {
    if (!this.#candidateAllowed(generation, false)) return;
    if (this.#lanes.has(candidate.attempt.attemptId)) return;
    const loaded = await this.#loadPlan(candidate, generation, false);
    if (loaded === null) return;
    const reservation = this.#reserve(loaded.binding.executor.adapterId);
    if (reservation === null) return;
    const hydrated = await this.dependencies.lifecycle.hydrateOwnedAuthority({
      attemptId: candidate.attempt.attemptId,
      expectedAttemptFence: candidate.attempt.fencingToken,
      expectedManagerIncarnationId: candidate.attempt.managerIncarnationId,
      expectedPhase: candidate.attempt.attemptPhase,
      nodeInstanceId: candidate.node.nodeInstanceId,
      runId: candidate.run.runId,
    });
    if (!this.#candidateAllowed(generation, false)) {
      await this.#settleHydratedAuthority(hydrated, loaded.planDocument, reservation);
      return;
    }
    if (hydrated.kind !== 'hydrated') {
      this.#release(reservation);
      return;
    }
    const lane = this.#createLane(hydrated.value.authority, loaded.planDocument, reservation);
    this.#ownLaneTask(lane, this.#resumeLane(lane, hydrated.value.recovery));
  }

  async #acquire(
    candidate: Extract<
      LifecycleDiscoveryCandidate,
      { readonly kind: 'expired_attempt' | 'handoff_attempt' }
    >,
    generation: Generation,
  ): Promise<void> {
    if (!this.#candidateAllowed(generation, false)) return;
    if (this.#lanes.has(candidate.attempt.attemptId)) return;
    const loaded = await this.#loadPlan(candidate, generation, false);
    if (loaded === null) return;
    const reservation = this.#reserve(loaded.binding.executor.adapterId);
    if (reservation === null) return;
    const result = await this.dependencies.lifecycle.acquire({
      candidate,
      idempotencyKey: this.dependencies.ids.nextLifecycleIdempotencyKey('acquire'),
      leasePolicy: this.#configuration.lease,
      successorManagerIncarnationId: generation.incarnationId,
    });
    if (!this.#candidateAllowed(generation, false)) {
      if (result.kind === 'committed') {
        await this.#settleCommittedAuthority(
          result.value.authority,
          loaded.planDocument,
          reservation,
        );
      } else if (result.kind === 'replayed') {
        const expectedPhase = result.value.recovery === 'start' ? 'claimed' : 'unknown';
        const hydrated = await this.dependencies.lifecycle.hydrateOwnedAuthority({
          attemptId: result.value.attemptId,
          expectedAttemptFence: result.value.successorFencingToken,
          expectedManagerIncarnationId: result.value.successorManagerIncarnationId,
          expectedPhase,
          nodeInstanceId: result.value.nodeInstanceId,
          runId: result.value.runId,
        });
        await this.#settleHydratedAuthority(hydrated, loaded.planDocument, reservation);
      } else {
        this.#release(reservation);
      }
      return;
    }
    if (result.kind === 'committed') {
      const lane = this.#createLane(result.value.authority, loaded.planDocument, reservation);
      this.#ownLaneTask(lane, this.#resumeLane(lane, result.value.recovery));
      return;
    }
    if (result.kind === 'replayed') {
      const expectedPhase = result.value.recovery === 'start' ? 'claimed' : 'unknown';
      const hydrated = await this.dependencies.lifecycle.hydrateOwnedAuthority({
        attemptId: result.value.attemptId,
        expectedAttemptFence: result.value.successorFencingToken,
        expectedManagerIncarnationId: result.value.successorManagerIncarnationId,
        expectedPhase,
        nodeInstanceId: result.value.nodeInstanceId,
        runId: result.value.runId,
      });
      if (!this.#candidateAllowed(generation, false)) {
        await this.#settleHydratedAuthority(hydrated, loaded.planDocument, reservation);
        return;
      }
      if (hydrated.kind === 'hydrated') {
        const lane = this.#createLane(hydrated.value.authority, loaded.planDocument, reservation);
        this.#ownLaneTask(lane, this.#resumeLane(lane, result.value.recovery));
        return;
      }
    }
    this.#release(reservation);
  }

  #createLane(
    authority: LifecycleAttemptAuthority,
    planDocument: RunExecutionPlanDocument,
    reservation: CapacityReservation,
  ): AuthorityLane {
    const lane: AuthorityLane = {
      authority,
      closed: false,
      handoffAbort: new AbortController(),
      invocationAbort: new AbortController(),
      operation: Promise.resolve(),
      planDocument,
      renewal: null,
      renewalPaused: false,
      reconciliationAttempts: 0,
      reconciliationTask: null,
      reservation,
    };
    this.#lanes.set(authority.attemptId, lane);
    this.#scheduleRenewal(lane);
    return lane;
  }

  #serialize(lane: AuthorityLane, operation: () => Promise<void>): Promise<void> {
    lane.operation = lane.operation.then(operation, operation);
    return lane.operation;
  }

  #scheduleRenewal(lane: AuthorityLane): void {
    if (lane.closed || lane.renewalPaused) return;
    lane.renewal = this.#renewAfterWait(lane)
      .catch(async () => {
        if (lane.closed || lane.invocationAbort.signal.aborted) return;
        await this.#serialize(lane, () => this.#handoff(lane, 'manager_recovery_failure'));
      })
      .catch(() => undefined);
  }

  async #renewAfterWait(lane: AuthorityLane): Promise<void> {
    await this.dependencies.scheduler.wait(
      this.#configuration.lease.heartbeatIntervalMs,
      lane.invocationAbort.signal,
    );
    if (lane.closed || lane.renewalPaused || lane.invocationAbort.signal.aborted) return;
    await this.#serialize(lane, async () => {
      if (lane.closed || lane.renewalPaused) return;
      const result = await this.dependencies.lifecycle.renewLease({
        authority: lane.authority,
        leasePolicy: this.#configuration.lease,
      });
      if (result.kind === 'committed') {
        lane.authority = result.value.authority;
        return;
      }
      lane.invocationAbort.abort();
      this.#closeLane(lane);
    });
    if (!lane.closed && !lane.renewalPaused) this.#scheduleRenewal(lane);
  }

  async #resumeLane(lane: AuthorityLane, recovery: 'start' | 'reconcile'): Promise<void> {
    if (recovery === 'start') await this.#startClaimed(lane);
    else await this.#serialize(lane, () => this.#reconcileUnknown(lane));
  }

  async #startClaimed(lane: AuthorityLane): Promise<void> {
    await this.#serialize(lane, async () => {
      if (lane.closed || this.#state === 'quiescing' || this.#state === 'draining') {
        await this.#handoff(lane, 'manager_shutdown');
        return;
      }
      if (!isClaimedAuthority(lane.authority)) {
        await this.#handoff(lane, 'manager_start_failure');
        return;
      }
      const result = await this.dependencies.lifecycle.verifyAndStart({
        authority: lane.authority,
        planDocument: lane.planDocument,
      });
      if (this.#isStopping()) {
        if (result.kind === 'committed') lane.authority = result.value.authority;
        await this.#handoff(lane, 'manager_shutdown');
        return;
      }
      if (result.kind === 'committed') {
        lane.authority = result.value.authority;
        this.#invokeExecute(lane, result.value);
        return;
      }
      if (result.kind === 'replayed') {
        const authority = await this.#hydrateReplay(
          lane,
          'start_committed',
          result.value.managerIncarnationId,
          result.value.fencingToken,
        );
        if (authority !== null) {
          lane.authority = authority;
          await this.#processExecute(lane, directUnknown());
        }
        return;
      }
      await this.#handoff(lane, 'manager_start_failure');
    });
  }

  #invokeExecute(lane: AuthorityLane, prepared: LifecyclePreparedExecuteCall): void {
    this.#ownLaneTask(
      lane,
      executorObservationNormalization
        .invokeExecute(() => prepared.execute.invoke(lane.invocationAbort.signal))
        .then((observation) =>
          this.#serialize(lane, () => this.#processExecute(lane, observation)),
        ),
    );
  }

  async #processExecute(
    lane: AuthorityLane,
    observation: LifecycleExecuteObservation,
  ): Promise<void> {
    if (lane.closed) return;
    if (!isStartedAuthority(lane.authority)) {
      await this.#handoff(lane, 'manager_recovery_failure');
      return;
    }
    const result = await this.dependencies.lifecycle.processExecuteObservation({
      authority: lane.authority,
      generatedOutputIds:
        observation.kind === 'succeeded'
          ? observation.outputs.map(() => this.dependencies.ids.nextOutputId())
          : [],
      idempotencyKey: this.dependencies.ids.nextLifecycleIdempotencyKey(
        'process_execute_observation',
      ),
      observation,
    });
    if (result.kind === 'committed' || result.kind === 'replayed') {
      lane.authority = result.value.authority;
      if (result.value.observation === 'unknown') await this.#reconcileUnknown(lane);
      else await this.#handoff(lane, 'manager_recovery_failure');
      return;
    }
    if (result.kind === 'requires_progression') {
      lane.authority = result.authority;
      await this.#handoff(lane, 'manager_progression_unavailable');
      return;
    }
    if (isStaleResult(result)) this.#closeLane(lane);
    else await this.#handoff(lane, 'manager_recovery_failure');
  }

  async #reconcileUnknown(lane: AuthorityLane): Promise<void> {
    if (lane.closed) return;
    if (!isUnknownAuthority(lane.authority)) {
      await this.#handoff(lane, 'manager_recovery_failure');
      return;
    }
    const result = await this.dependencies.lifecycle.prepareReconciliation({
      authority: lane.authority,
      beginIdempotencyKey:
        this.dependencies.ids.nextLifecycleIdempotencyKey('prepare_reconciliation'),
      planDocument: lane.planDocument,
    });
    if (result.kind === 'committed') {
      lane.authority = result.value.authority;
      this.#invokeReconcile(lane, result.value);
      return;
    }
    if (result.kind === 'replayed') {
      const authority = await this.#hydrateReplay(
        lane,
        'reconciling',
        result.value.managerIncarnationId,
        result.value.fencingToken,
      );
      if (authority !== null) {
        lane.authority = authority;
        await this.#processReconcile(lane, reconciledUnknown());
      }
      return;
    }
    if (isStaleResult(result)) this.#closeLane(lane);
    else await this.#handoff(lane, 'manager_recovery_failure');
  }

  #invokeReconcile(lane: AuthorityLane, prepared: LifecyclePreparedReconcileCall): void {
    this.#ownLaneTask(
      lane,
      executorObservationNormalization
        .invokeReconcile(() => prepared.reconcile.invoke(lane.invocationAbort.signal))
        .then((observation) =>
          this.#serialize(lane, () => this.#processReconcile(lane, observation)),
        ),
    );
  }

  async #processReconcile(
    lane: AuthorityLane,
    observation: LifecycleReconcileObservation,
  ): Promise<void> {
    if (lane.closed) return;
    if (!isReconcilingAuthority(lane.authority)) {
      await this.#handoff(lane, 'manager_recovery_failure');
      return;
    }
    const result = await this.dependencies.lifecycle.processReconcileObservation({
      authority: lane.authority,
      generatedOutputIds:
        observation.kind === 'succeeded'
          ? observation.outputs.map(() => this.dependencies.ids.nextOutputId())
          : [],
      idempotencyKey: this.dependencies.ids.nextLifecycleIdempotencyKey(
        'process_reconcile_observation',
      ),
      observation,
    });
    if (result.kind === 'committed' || result.kind === 'replayed') {
      lane.authority = result.value.authority;
      if (result.value.observation === 'running') {
        this.#scheduleRepeatedReconciliation(lane);
        return;
      }
      if (result.value.observation === 'unknown') {
        await this.#reconcileUnknown(lane);
        return;
      }
      this.#closeLane(lane);
      return;
    }
    if (result.kind === 'requires_progression') {
      lane.authority = result.authority;
      await this.#handoff(lane, 'manager_progression_unavailable');
      return;
    }
    if (isStaleResult(result)) this.#closeLane(lane);
    else await this.#handoff(lane, 'manager_recovery_failure');
  }

  #scheduleRepeatedReconciliation(lane: AuthorityLane): void {
    if (lane.closed || lane.reconciliationTask !== null) return;
    const binding = findBinding(lane.planDocument, lane.authority.nodeKey);
    if (binding === null || lane.reconciliationAttempts >= binding.retryPolicy.maximumAttempts) {
      this.#ownLaneTask(
        lane,
        this.#serialize(lane, () => this.#handoff(lane, 'manager_recovery_failure')),
      );
      return;
    }
    const exponent = lane.reconciliationAttempts;
    const delay = Math.min(
      binding.retryPolicy.initialBackoffMs * binding.retryPolicy.backoffMultiplier ** exponent,
      binding.retryPolicy.maximumBackoffMs,
    );
    lane.reconciliationAttempts += 1;
    lane.reconciliationTask = this.dependencies.scheduler
      .wait(delay, lane.invocationAbort.signal)
      .then(() => this.#serialize(lane, () => this.#processExecute(lane, directUnknown())))
      .catch(() => {
        if (!lane.closed && !lane.invocationAbort.signal.aborted) {
          return this.#serialize(lane, () => this.#handoff(lane, 'manager_recovery_failure'));
        }
        return Promise.resolve();
      })
      .then(() => {
        lane.reconciliationTask = null;
      });
  }

  async #hydrateReplay(
    lane: AuthorityLane,
    expectedPhase: 'start_committed' | 'reconciling',
    managerIncarnationId: string,
    fencingToken: number,
  ): Promise<LifecycleAttemptAuthority | null> {
    const hydrated = await this.dependencies.lifecycle.hydrateOwnedAuthority({
      attemptId: lane.authority.attemptId,
      expectedAttemptFence: fencingToken,
      expectedManagerIncarnationId: managerIncarnationId,
      expectedPhase,
      nodeInstanceId: lane.authority.nodeInstanceId,
      runId: lane.authority.runId,
    });
    if (hydrated.kind === 'hydrated') return hydrated.value.authority;
    if (isStaleResult(hydrated)) this.#closeLane(lane);
    else await this.#handoff(lane, 'manager_recovery_failure');
    return null;
  }

  async #handoffAll(
    reason:
      | 'manager_progression_unavailable'
      | 'manager_recovery_failure'
      | 'manager_shutdown'
      | 'manager_start_failure',
  ): Promise<void> {
    await Promise.all(
      [...this.#lanes.values()].map((lane) =>
        this.#serialize(lane, () => this.#handoff(lane, reason)),
      ),
    );
  }

  async #handoff(
    lane: AuthorityLane,
    reason:
      | 'manager_progression_unavailable'
      | 'manager_recovery_failure'
      | 'manager_shutdown'
      | 'manager_start_failure',
  ): Promise<void> {
    if (lane.closed) return;
    lane.renewalPaused = true;
    const generatedHandoffId = this.dependencies.ids.nextHandoffId();
    const idempotencyKey = this.dependencies.ids.nextLifecycleIdempotencyKey('write_handoff');
    await this.#attemptHandoff(lane, reason, generatedHandoffId, idempotencyKey);
  }

  async #attemptHandoff(
    lane: AuthorityLane,
    reason:
      | 'manager_progression_unavailable'
      | 'manager_recovery_failure'
      | 'manager_shutdown'
      | 'manager_start_failure',
    generatedHandoffId: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (lane.closed) return;
    try {
      const result = await this.dependencies.lifecycle.writeHandoff({
        authority: lane.authority,
        generatedHandoffId,
        idempotencyKey,
        reason,
      });
      if (result.kind === 'committed' || result.kind === 'replayed' || isStaleResult(result)) {
        this.#closeLane(lane);
        return;
      }
    } catch {
      // The durable outcome is ambiguous. Retry the exact identity until authority is settled.
    }
    await this.#waitForHandoffRetry(lane);
    if (!lane.closed) {
      await this.#attemptHandoff(lane, reason, generatedHandoffId, idempotencyKey);
    }
  }

  async #waitForHandoffRetry(lane: AuthorityLane): Promise<void> {
    try {
      await this.dependencies.scheduler.wait(
        this.#configuration.pollIntervalMs,
        lane.handoffAbort.signal,
      );
    } catch {
      // An active lane retains and retries the exact durable handoff identity.
    }
  }

  #ownLaneTask(lane: AuthorityLane, task: Promise<void>): void {
    void task
      .catch(async () => {
        if (lane.closed || lane.invocationAbort.signal.aborted) return;
        await this.#serialize(lane, () => this.#handoff(lane, 'manager_recovery_failure'));
      })
      .catch(() => undefined);
  }

  #closeLane(lane: AuthorityLane): void {
    if (lane.closed) return;
    lane.closed = true;
    lane.invocationAbort.abort();
    lane.handoffAbort.abort();
    lane.reconciliationTask = null;
    this.#lanes.delete(lane.authority.attemptId);
    this.#release(lane.reservation);
    const generation = this.#generation;
    if (generation !== null && this.#state === 'draining' && this.#lanes.size === 0) {
      this.#finishStopped(generation);
    }
  }
}

export const buildRunManager = (
  dependencies: RunManagerSupervisorDependencies,
  options?: RunManagerSupervisorOptions,
): RunManagerSupervisor => new InternalRunManagerSupervisor(dependencies, options);
