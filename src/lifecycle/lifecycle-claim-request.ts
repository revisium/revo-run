import type { RunExecutionPlanDocument, LeasePolicy } from '../spec/index.js';
import type { LifecycleDiscoveryCandidate } from './lifecycle-discovery-candidate.js';

export interface LifecycleClaimRequest {
  readonly candidate: Extract<LifecycleDiscoveryCandidate, { readonly kind: 'claimable_node' }>;
  readonly planDocument: RunExecutionPlanDocument;
  readonly generatedAttemptId: string;
  readonly generatedDispatchIdempotencyKey: string;
  readonly managerIncarnationId: string;
  readonly ownerLabel: string;
  readonly leasePolicy: LeasePolicy;
  readonly idempotencyKey: string;
}
