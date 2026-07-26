import type { AttemptStatus } from '../domain/index.js';

export interface RunStoreObservedAttempt {
  readonly attemptId: string;
  readonly attemptRevision: number;
  readonly attemptStatus: Extract<
    AttemptStatus,
    'claimed' | 'start_committed' | 'unknown' | 'reconciling'
  >;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
}
