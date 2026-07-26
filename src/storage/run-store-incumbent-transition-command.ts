import type { RunStoreNonRenewIncumbentTransitionCommand } from './run-store-non-renew-incumbent-transition-command.js';
import type { RunStoreRenewLeaseTransitionCommand } from './run-store-renew-lease-transition-command.js';

export type RunStoreIncumbentTransitionCommand =
  | RunStoreRenewLeaseTransitionCommand
  | RunStoreNonRenewIncumbentTransitionCommand;
