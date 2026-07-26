import type { ExecutorInvocationSnapshot } from '../spec/index.js';
import type { LifecyclePreparedExecuteCapability } from './lifecycle-prepared-execute-capability.js';
import type { LifecycleStartedExecutionAuthority } from './lifecycle-started-execution-authority.js';

export interface LifecyclePreparedExecuteCall {
  readonly kind: 'execute';
  readonly execute: LifecyclePreparedExecuteCapability;
  readonly invocation: ExecutorInvocationSnapshot;
  readonly authority: LifecycleStartedExecutionAuthority;
}
