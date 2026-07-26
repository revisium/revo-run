import type { AttemptStatus } from '../domain/index.js';

export interface RunStoreOwnershipPayloadBase {
  readonly previousManagerIncarnationId: string;
  readonly successorManagerIncarnationId: string;
  readonly previousFencingToken: number;
  readonly successorFencingToken: number;
  readonly fromAttemptStatus: Extract<
    AttemptStatus,
    'claimed' | 'start_committed' | 'unknown' | 'reconciling'
  >;
  readonly toAttemptStatus: 'claimed' | 'unknown';
  readonly fromNodeStatus: 'executing' | 'unknown';
  readonly toNodeStatus: 'executing' | 'unknown';
}
