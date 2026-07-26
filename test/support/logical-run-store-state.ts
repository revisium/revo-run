import type { Attempt, Run, RunNodeInstance, RunOutput } from '../../src/domain/index.js';
import type {
  AttemptHandoffKey,
  AttemptHandoffState,
  RunStoreEvent,
  RunStoreIdempotencyRecord,
} from '../../src/storage/index.js';

export interface LogicalRunStoreState {
  readonly runs: Map<string, Run>;
  readonly nodes: Map<string, RunNodeInstance>;
  readonly attempts: Map<string, Attempt>;
  readonly outputs: Map<string, RunOutput>;
  readonly events: Map<string, RunStoreEvent[]>;
  readonly idempotency: Map<string, RunStoreIdempotencyRecord>;
  readonly handoffs: Map<string, AttemptHandoffState>;
}

export const createLogicalRunStoreState = (): LogicalRunStoreState => ({
  attempts: new Map(),
  events: new Map(),
  handoffs: new Map(),
  idempotency: new Map(),
  nodes: new Map(),
  outputs: new Map(),
  runs: new Map(),
});

export const handoffKey = (key: AttemptHandoffKey): string =>
  JSON.stringify([key.attemptId, key.incumbentFencingToken]);

export const activationIdKey = (runId: string, activationId: string): string =>
  JSON.stringify([runId, activationId]);

export const scopedActivationKey = (node: RunNodeInstance): string =>
  JSON.stringify([node.runId, node.forkScopeKey, node.activationKey]);

export const snapshotValue = <Value>(value: Value): Value => {
  const snapshot = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(snapshot);
  return snapshot;
};
