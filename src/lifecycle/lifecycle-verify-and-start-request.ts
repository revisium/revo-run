import type { RunExecutionPlanDocument } from '../spec/index.js';
import type { LifecycleClaimedExecutionAuthority } from './lifecycle-claimed-execution-authority.js';

export interface LifecycleVerifyAndStartRequest {
  readonly authority: LifecycleClaimedExecutionAuthority;
  readonly planDocument: RunExecutionPlanDocument;
}
