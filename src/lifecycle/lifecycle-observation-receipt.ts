import type { LifecycleStartedExecutionAuthority } from './lifecycle-started-execution-authority.js';
import type { LifecycleUnknownExecutionAuthority } from './lifecycle-unknown-execution-authority.js';

export interface LifecycleObservationReceipt {
  readonly authority: LifecycleStartedExecutionAuthority | LifecycleUnknownExecutionAuthority;
  readonly observation: 'running' | 'unknown';
}
