import type { LeasePolicy } from '../spec/index.js';

export interface RunStoreRenewalDiscovery {
  readonly managerIncarnationId: string;
  readonly leasePolicy: LeasePolicy;
}
