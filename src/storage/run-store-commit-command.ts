import type { RunStoreAcquireAttemptCommand } from './run-store-acquire-attempt-command.js';
import type { RunStoreClaimAttemptCommand } from './run-store-claim-attempt-command.js';
import type { RunStoreCreateRunCommand } from './run-store-create-run-command.js';
import type { RunStoreIncumbentTransitionCommand } from './run-store-incumbent-transition-command.js';
import type { RunStoreUnownedTransitionCommand } from './run-store-unowned-transition-command.js';
import type { RunStoreWriteHandoffCommand } from './run-store-write-handoff-command.js';

export type RunStoreCommitCommand =
  | RunStoreCreateRunCommand
  | RunStoreClaimAttemptCommand
  | RunStoreUnownedTransitionCommand
  | RunStoreIncumbentTransitionCommand
  | RunStoreWriteHandoffCommand
  | RunStoreAcquireAttemptCommand;
