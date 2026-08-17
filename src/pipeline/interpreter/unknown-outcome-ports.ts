import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { RecoveryPolicy, RetryPolicy } from '../../contracts/pipeline/task-policy.js';

export type UnknownOutcomeResolution =
  | {
      readonly kind: 'adoptSuccess';
      readonly commandId: string;
      readonly outcome: string;
      readonly output?: NodeOutput;
    }
  | { readonly kind: 'markFailed'; readonly commandId: string; readonly errorCode: string }
  | {
      readonly kind: 'retry';
      readonly commandId: string;
      readonly attemptId: string;
    }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'fail' };

export type WaitForUnknownOutcome = (
  request: RunExecutorRequest,
  recovery: RecoveryPolicy,
  retry: RetryPolicy | undefined,
  reconciliationRound: number,
) => Promise<UnknownOutcomeResolution>;
