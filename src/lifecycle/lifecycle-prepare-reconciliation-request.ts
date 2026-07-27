import type { RunExecutionPlanDocument } from '../spec/index.js';
import type { LifecycleUnknownExecutionAuthority } from './lifecycle-unknown-execution-authority.js';

export interface LifecyclePrepareReconciliationRequest {
  readonly authority: LifecycleUnknownExecutionAuthority;
  readonly beginIdempotencyKey: string;
  readonly planDocument: RunExecutionPlanDocument;
}
