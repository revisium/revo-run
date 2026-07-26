import type { RunFault } from '../errors/index.js';

export interface LifecycleFaultResult {
  readonly kind: 'fault';
  readonly fault: RunFault;
}
