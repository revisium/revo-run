import type { LeasePolicy } from '../spec/index.js';
import type { LifecycleDiscoveryCandidate } from './lifecycle-discovery-candidate.js';

export interface LifecycleAcquireRequest {
  readonly candidate: Extract<
    LifecycleDiscoveryCandidate,
    { readonly kind: 'expired_attempt' | 'handoff_attempt' }
  >;
  readonly successorManagerIncarnationId: string;
  readonly leasePolicy: LeasePolicy;
  readonly idempotencyKey: string;
}
