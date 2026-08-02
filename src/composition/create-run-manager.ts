import { createManagerLifecycleFacade } from '../lifecycle/manager-construction.js';
import { DefaultRunManager } from '../manager/construction.js';
import type { RunManager } from '../manager/index.js';
import type { ExecutionPlanSource, ExecutorResolver, ManagerIdSource } from '../ports/index.js';
import type { RunStore } from '../storage/index.js';
import type { RunManagerOptions } from './run-manager-options.js';

const hasMethod = (value: object, name: string): boolean =>
  name in value && typeof Reflect.get(value, name) === 'function';

const isRunStore = (value: object): value is RunStore =>
  ['transaction', 'discover', 'getRun', 'listRuns', 'readEvents'].every((name) =>
    hasMethod(value, name),
  );

const isPlanSource = (value: object): value is ExecutionPlanSource => hasMethod(value, 'loadExact');

const isExecutorResolver = (value: object): value is ExecutorResolver =>
  hasMethod(value, 'resolveExact');

const isManagerIdSource = (value: object): value is ManagerIdSource =>
  [
    'nextRunId',
    'nextProgressionOccurrenceKey',
    'nextProgressionAllocationSeed',
    'nextManagerIncarnationId',
    'nextAttemptId',
    'nextHandoffId',
    'nextOutputId',
    'nextLifecycleIdempotencyKey',
  ].every((name) => hasMethod(value, name));

export const createRunManager = (options: RunManagerOptions): RunManager => {
  if (
    options.store.kind !== 'run_manager_persistence' ||
    !isRunStore(options.store.source) ||
    options.plans.kind !== 'run_manager_plans' ||
    !isPlanSource(options.plans.source) ||
    options.executors.kind !== 'run_manager_executors' ||
    !isExecutorResolver(options.executors.source) ||
    options.ids.kind !== 'run_manager_identifiers' ||
    !isManagerIdSource(options.ids.source)
  ) {
    throw new TypeError('INVALID_INPUT: RunManager dependency adapter is invalid.');
  }
  const coordination = {
    drainTimeoutMs: 30_000,
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    ownerLabel: 'revo-run-manager',
    pollIntervalMs: 25,
    ...options.coordination,
  };
  if (coordination.heartbeatIntervalMs >= coordination.leaseDurationMs) {
    throw new TypeError('INVALID_INPUT: heartbeat interval must be shorter than the lease.');
  }
  const lifecycle = createManagerLifecycleFacade({
    coordination: {
      leasePolicy: {
        heartbeatIntervalMs: coordination.heartbeatIntervalMs,
        leaseDurationMs: coordination.leaseDurationMs,
      },
      ownerLabel: coordination.ownerLabel,
    },
    executors: options.executors.source,
    ids: options.ids.source,
    plans: options.plans.source,
    store: options.store.source,
  });
  return new DefaultRunManager({
    drainTimeoutMs: coordination.drainTimeoutMs,
    lifecycle,
    pollIntervalMs: coordination.pollIntervalMs,
  });
};
