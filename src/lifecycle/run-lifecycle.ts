import type { LifecycleAcquireRequest } from './lifecycle-acquire-request.js';
import type { LifecycleAcquireResult } from './lifecycle-acquire-result.js';
import type { LifecycleClaimRequest } from './lifecycle-claim-request.js';
import type { LifecycleClaimResult } from './lifecycle-claim-result.js';
import type { LifecycleDiscoveryRequest } from './lifecycle-discovery-request.js';
import type { LifecycleDiscoveryResult } from './lifecycle-discovery-result.js';
import type { LifecycleRenewLeaseRequest } from './lifecycle-renew-lease-request.js';
import type { LifecycleRenewLeaseResult } from './lifecycle-renew-lease-result.js';
import type { LifecycleWriteHandoffRequest } from './lifecycle-write-handoff-request.js';
import type { LifecycleWriteHandoffResult } from './lifecycle-write-handoff-result.js';

export interface RunLifecycle {
  discover(request: LifecycleDiscoveryRequest): Promise<LifecycleDiscoveryResult>;
  claim(request: LifecycleClaimRequest): Promise<LifecycleClaimResult>;
  renewLease(request: LifecycleRenewLeaseRequest): Promise<LifecycleRenewLeaseResult>;
  writeHandoff(request: LifecycleWriteHandoffRequest): Promise<LifecycleWriteHandoffResult>;
  acquire(request: LifecycleAcquireRequest): Promise<LifecycleAcquireResult>;
}
