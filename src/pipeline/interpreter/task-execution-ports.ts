import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import type { RecoveryPolicy } from '../../contracts/pipeline/task-policy.js';

export type ExecuteNodeEffect = (
  request: RunExecutorRequest,
  timeoutMs: number,
  recovery: RecoveryPolicy,
  nextReconciliationRound: number,
  permitCommandId?: string,
) => Promise<
  | {
      readonly kind: 'effectResult';
      readonly execution: RunNodeExecution;
      readonly nextReconciliationRound: number;
    }
  | {
      readonly kind: 'effectNotFound';
      readonly nextReconciliationRound: number;
    }
  | { readonly kind: 'executionLimitExceeded' }
  | { readonly kind: 'outcomeUnknown'; readonly reconciliationRound: number }
  | { readonly kind: 'recoveryExhausted'; readonly reconciliationRound: number }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' }
>;

export type WaitForRetry = (request: RunExecutorRequest, delayMs: number) => Promise<void>;
