import type { ExecutorFailureFault } from '../errors/index.js';
import type { ExecutorOutput, RunOutputPayload } from '../spec/index.js';
import type { RunProgressionValueFact } from './run-progression-value-fact.js';

export type RunProgressionCommand =
  | {
      readonly kind: 'initialize';
      readonly occurrenceKey: string;
      readonly values: readonly RunProgressionValueFact[];
    }
  | {
      readonly kind: 'task_outcome';
      readonly nodeKey: string;
      readonly idempotencyKey: string;
      readonly outcome:
        | {
            readonly kind: 'succeeded';
            readonly outputs: readonly ExecutorOutput[];
            readonly values: readonly RunProgressionValueFact[];
          }
        | { readonly kind: 'failed'; readonly fault: ExecutorFailureFault }
        | { readonly kind: 'cancelled' }
        | { readonly kind: 'skipped' };
    }
  | {
      readonly kind: 'consensus_verdict';
      readonly nodeKey: string;
      readonly candidateKey: string;
      readonly verdict: 'approve' | 'reject' | 'abstain';
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'human_gate_resolution';
      readonly nodeKey: string;
      readonly activationId: string;
      readonly resolution: string;
      readonly values: readonly RunProgressionValueFact[];
      readonly answerOutput: RunOutputPayload;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'retired_attempt_observation';
      readonly nodeKey: string;
      readonly attemptId: string;
      readonly idempotencyKey: string;
    };
