import type { AttemptStatus } from '../domain/index.js';
import type { RunStoreHandoffExpectation } from './run-store-handoff-expectation.js';

export interface RunStoreAttemptExpectation {
  readonly attemptId: string;
  readonly revision: number;
  readonly status: AttemptStatus;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
  readonly handoff: RunStoreHandoffExpectation;
}
