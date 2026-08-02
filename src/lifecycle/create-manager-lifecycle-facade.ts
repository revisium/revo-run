import type { Run } from '../domain/index.js';
import { snapshotExecutionPlanPin, snapshotPortableJsonValue } from '../policy/index.js';
import type { ManagerLifecycleIdempotencyPurpose } from '../ports/index.js';
import { createRunLifecycle } from './create-run-lifecycle.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';
import type { LifecycleClaimedExecutionAuthority } from './lifecycle-claimed-execution-authority.js';
import type { LifecycleReconcilingExecutionAuthority } from './lifecycle-reconciling-execution-authority.js';
import type { LifecycleStartedExecutionAuthority } from './lifecycle-started-execution-authority.js';
import type { LifecycleUnknownExecutionAuthority } from './lifecycle-unknown-execution-authority.js';
import type { ManagerLifecycleFacadeDependencies } from './manager-lifecycle-facade-dependencies.js';
import type { ManagerLifecycleFacade } from './manager-lifecycle-facade.js';
import type { ManagerRunSnapshot } from './manager-run-snapshot.js';
import type { ManagerStartRunCommand } from './manager-start-run-command.js';
import { singleTaskProgression } from './single-task-progression.js';
import { verifyAndStart } from './verify-and-start.js';

const snapshot = (run: Run): ManagerRunSnapshot =>
  Object.freeze({
    createdAt: run.createdAt,
    id: run.id,
    input: snapshotPortableJsonValue(run.input),
    plan: snapshotExecutionPlanPin(run.planPin),
    status: run.status,
    terminalAt: run.terminalAt,
    terminalFault: run.terminalFault,
    updatedAt: run.updatedAt,
  });

const resultDetail = (
  result: object,
): { readonly code: string; readonly message: string } | undefined => {
  const value =
    'fault' in result ? result.fault : 'conflict' in result ? result.conflict : undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('code' in value) ||
    typeof value.code !== 'string' ||
    !('message' in value) ||
    typeof value.message !== 'string'
  ) {
    return undefined;
  }
  return { code: value.code, message: value.message };
};

const resultError = (result: object): Error => {
  const detail = resultDetail(result);
  return new TypeError(
    `${detail?.code ?? 'INVALID_STATE'}: ${detail?.message ?? 'Lifecycle operation failed.'}`,
  );
};

const isStartedAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleStartedExecutionAuthority => authority.attemptPhase === 'start_committed';

const isClaimedAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleClaimedExecutionAuthority => authority.attemptPhase === 'claimed';

const isUnknownAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleUnknownExecutionAuthority => authority.attemptPhase === 'unknown';

const isReconcilingAuthority = (
  authority: LifecycleAttemptAuthority,
): authority is LifecycleReconcilingExecutionAuthority => authority.attemptPhase === 'reconciling';

export const createManagerLifecycleFacade = (
  dependencies: ManagerLifecycleFacadeDependencies,
): ManagerLifecycleFacade => {
  const lifecycle = createRunLifecycle(dependencies);
  let active:
    | { readonly managerIncarnationId: string; readonly authority: LifecycleAttemptAuthority }
    | undefined;
  let shutdownHandoff:
    | {
        readonly managerIncarnationId: string;
        readonly reason: 'manager_shutdown' | 'manager_start_failure';
        readonly authority: LifecycleAttemptAuthority;
        readonly generatedHandoffId: string;
        readonly idempotencyKey: string;
        completion: Promise<void> | undefined;
      }
    | undefined;
  const idempotency = (purpose: ManagerLifecycleIdempotencyPurpose): string =>
    dependencies.ids.nextLifecycleIdempotencyKey(purpose);
  const waitForHeartbeat = (signal: AbortSignal): Promise<'heartbeat' | 'aborted'> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve('aborted');
      const timeout = setTimeout(
        () => resolve('heartbeat'),
        dependencies.coordination.leasePolicy.heartbeatIntervalMs,
      );
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          resolve('aborted');
        },
        { once: true },
      );
    });
  const observeWithRenewal = async <Observation>(input: {
    readonly authority: LifecycleAttemptAuthority;
    readonly invocation: Promise<Observation>;
    readonly managerIncarnationId: string;
    readonly signal: AbortSignal;
  }): Promise<
    { readonly authority: LifecycleAttemptAuthority; readonly observation: Observation } | undefined
  > => {
    let authority = input.authority;
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- every renewal depends on the preceding fenced authority.
      const outcome = await Promise.race([
        input.invocation.then((value) => ({ kind: 'observation' as const, value })),
        waitForHeartbeat(input.signal).then((kind) => ({ kind })),
      ]);
      if (outcome.kind === 'observation') {
        return input.signal.aborted ? undefined : { authority, observation: outcome.value };
      }
      if (outcome.kind === 'aborted') return undefined;
      // eslint-disable-next-line no-await-in-loop -- lease renewal is intentionally serialized by fence revision.
      const renewed = await lifecycle.renewLease({
        authority,
        leasePolicy: dependencies.coordination.leasePolicy,
      });
      if (renewed.kind !== 'committed') throw resultError(renewed);
      authority = renewed.value.authority;
      active = { authority, managerIncarnationId: input.managerIncarnationId };
    }
  };

  const facade: ManagerLifecycleFacade = {
    beginStartCycle: () => dependencies.ids.nextManagerIncarnationId(),
    startRun: async (command: ManagerStartRunCommand) => {
      const pin = snapshotExecutionPlanPin(command.plan);
      const loaded = await dependencies.plans.loadExact(pin);
      if (loaded.kind !== 'loaded') {
        throw new TypeError(`${loaded.fault.code}: ${loaded.fault.message}`);
      }
      const result = await singleTaskProgression.initialize(dependencies.store, {
        allocationSeed: dependencies.ids.nextProgressionAllocationSeed(),
        idempotencyKey: command.idempotencyKey,
        input: command.input,
        occurrenceKey: dependencies.ids.nextProgressionOccurrenceKey(),
        planDocument: loaded.planDocument,
        runId: dependencies.ids.nextRunId(),
      });
      if (result.kind !== 'committed' && result.kind !== 'replayed') throw resultError(result);
      return snapshot(result.run);
    },
    getRun: async (runId: string) => {
      const result = await dependencies.store.getRun(runId);
      if (result.kind === 'not_found') return undefined;
      if (result.kind !== 'found') throw new TypeError('INVALID_INPUT: Store rejected Run lookup.');
      return snapshot(result.value);
    },
    recover: async (managerIncarnationId: string, signal: AbortSignal) => {
      while (!signal.aborted) {
        // eslint-disable-next-line no-await-in-loop -- recovery candidates are fenced and processed in discovery order.
        const discovered = await lifecycle.discover({
          kinds: ['handoff_attempt', 'expired_attempt'],
          limit: 1,
          renewal: null,
          scan: { kind: 'start' },
        });
        if (discovered.kind !== 'page' || discovered.page.items.length === 0) return;
        // eslint-disable-next-line no-await-in-loop -- start is an ordered recovery barrier, not a parallel claim loop.
        await facade.runOne(managerIncarnationId, signal, 'recovery');
      }
    },
    runOne: async (
      managerIncarnationId: string,
      signal: AbortSignal,
      mode: 'normal' | 'recovery' = 'normal',
    ) => {
      const discovered = await lifecycle.discover({
        kinds:
          mode === 'recovery'
            ? ['handoff_attempt', 'expired_attempt']
            : ['handoff_attempt', 'expired_attempt', 'claimable_node'],
        limit: 1,
        renewal: null,
        scan: { kind: 'start' },
      });
      const candidate = discovered.kind === 'page' ? discovered.page.items[0] : undefined;
      if (candidate === undefined || signal.aborted) return;
      const loaded = await dependencies.plans.loadExact(candidate.run.planPin);
      if (loaded.kind !== 'loaded' || signal.aborted) return;
      let claimedAuthority: LifecycleAttemptAuthority;
      let recovery: 'start' | 'reconcile';
      if (candidate.kind === 'claimable_node') {
        const claimed = await lifecycle.claim({
          candidate,
          generatedAttemptId: dependencies.ids.nextAttemptId(),
          generatedDispatchIdempotencyKey: idempotency('verify_and_start'),
          idempotencyKey: idempotency('claim'),
          leasePolicy: dependencies.coordination.leasePolicy,
          managerIncarnationId,
          ownerLabel: dependencies.coordination.ownerLabel,
          planDocument: loaded.planDocument,
        });
        if (claimed.kind !== 'committed') throw resultError(claimed);
        claimedAuthority = claimed.value.authority;
        recovery = 'start';
      } else if (candidate.kind === 'expired_attempt' || candidate.kind === 'handoff_attempt') {
        const acquired = await lifecycle.acquire({
          candidate,
          idempotencyKey: idempotency('acquire'),
          leasePolicy: dependencies.coordination.leasePolicy,
          successorManagerIncarnationId: managerIncarnationId,
        });
        if (acquired.kind !== 'committed') throw resultError(acquired);
        claimedAuthority = acquired.value.authority;
        recovery = acquired.value.recovery;
      } else {
        return;
      }
      active = { authority: claimedAuthority, managerIncarnationId };
      shutdownHandoff = undefined;
      if (signal.aborted) return;
      if (recovery === 'reconcile') {
        if (!isUnknownAuthority(claimedAuthority)) {
          throw new TypeError('INVALID_STATE: Recovery authority is not unknown.');
        }
        const prepared = await lifecycle.prepareReconciliation({
          authority: claimedAuthority,
          beginIdempotencyKey: idempotency('prepare_reconciliation'),
          planDocument: loaded.planDocument,
        });
        if (prepared.kind !== 'committed') throw resultError(prepared);
        active = { authority: prepared.value.authority, managerIncarnationId };
        const observed = await observeWithRenewal({
          authority: prepared.value.authority,
          invocation: prepared.value.reconcile.invoke(signal),
          managerIncarnationId,
          signal,
        });
        if (observed === undefined) return;
        if (!isReconcilingAuthority(observed.authority)) {
          throw new TypeError('INVALID_STATE: Renewed reconciliation authority changed phase.');
        }
        const observation = observed.observation;
        const processed = await lifecycle.processReconcileObservation({
          authority: observed.authority,
          generatedOutputIds:
            observation.kind === 'succeeded'
              ? observation.outputs.map(() => dependencies.ids.nextOutputId())
              : [],
          idempotencyKey: idempotency('process_reconcile_observation'),
          observation,
        });
        if (processed.kind === 'requires_progression') {
          const progressed = await singleTaskProgression.progressOutcome(dependencies.store, {
            allocationSeed: dependencies.ids.nextProgressionAllocationSeed(),
            authority: processed.authority,
            idempotencyKey: idempotency('progress_task_outcome'),
            observation: processed.observation,
            planDocument: loaded.planDocument,
          });
          if (progressed.kind !== 'committed' && progressed.kind !== 'replayed') {
            throw resultError(progressed);
          }
        }
        active = undefined;
        return;
      }
      if (!isClaimedAuthority(claimedAuthority)) {
        throw new TypeError('INVALID_STATE: Start recovery authority is not claimed.');
      }
      const started = await verifyAndStart(
        dependencies.store,
        dependencies.executors,
        { authority: claimedAuthority, planDocument: loaded.planDocument },
        signal,
      );
      if (started.kind !== 'committed') throw resultError(started);
      let authority: LifecycleAttemptAuthority = started.value.authority;
      active = { authority, managerIncarnationId };
      if (signal.aborted) return;
      const observed = await observeWithRenewal({
        authority,
        invocation: started.value.execute.invoke(signal),
        managerIncarnationId,
        signal,
      });
      if (observed === undefined) return;
      authority = observed.authority;
      if (!isStartedAuthority(authority)) {
        throw new TypeError('INVALID_STATE: Renewed execution authority changed phase.');
      }
      const generatedOutputIds =
        observed.observation.kind === 'succeeded'
          ? observed.observation.outputs.map(() => dependencies.ids.nextOutputId())
          : [];
      const processed = await lifecycle.processExecuteObservation({
        authority,
        generatedOutputIds,
        idempotencyKey: idempotency('process_execute_observation'),
        observation: observed.observation,
      });
      if (processed.kind === 'requires_progression') {
        const progressed = await singleTaskProgression.progressOutcome(dependencies.store, {
          allocationSeed: dependencies.ids.nextProgressionAllocationSeed(),
          authority: processed.authority,
          idempotencyKey: idempotency('progress_task_outcome'),
          observation: processed.observation,
          planDocument: loaded.planDocument,
        });
        if (progressed.kind !== 'committed' && progressed.kind !== 'replayed') {
          if (mode === 'normal') {
            await lifecycle.writeHandoff({
              authority: processed.authority,
              generatedHandoffId: dependencies.ids.nextHandoffId(),
              idempotencyKey: idempotency('write_handoff'),
              reason: 'manager_progression_unavailable',
            });
          }
          throw resultError(progressed);
        }
      }
      active = undefined;
    },
    handoffActive: async (managerIncarnationId: string, reason = 'manager_shutdown') => {
      if (active === undefined || active.managerIncarnationId !== managerIncarnationId) return;
      if (
        shutdownHandoff?.managerIncarnationId === managerIncarnationId &&
        shutdownHandoff.reason === reason
      ) {
        if (shutdownHandoff.completion !== undefined) return shutdownHandoff.completion;
      } else {
        shutdownHandoff = {
          authority: active.authority,
          completion: undefined,
          generatedHandoffId: dependencies.ids.nextHandoffId(),
          idempotencyKey: idempotency('write_handoff'),
          managerIncarnationId,
          reason,
        };
      }
      const pending = shutdownHandoff;
      const authority = pending.authority;
      const completion = lifecycle
        .writeHandoff({
          authority,
          generatedHandoffId: pending.generatedHandoffId,
          idempotencyKey: pending.idempotencyKey,
          reason,
        })
        .then((result) => {
          if (result.kind !== 'committed' && result.kind !== 'replayed') throw resultError(result);
          if (
            active?.managerIncarnationId === managerIncarnationId &&
            active.authority.attemptId === authority.attemptId &&
            active.authority.fencingToken === authority.fencingToken
          ) {
            active = undefined;
          }
        })
        .catch((error: unknown) => {
          if (pending.completion === completion) pending.completion = undefined;
          throw error;
        });
      pending.completion = completion;
      return completion;
    },
  };
  return Object.freeze(facade);
};
