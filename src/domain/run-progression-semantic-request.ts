import type { RunProgressionValueFact } from './run-progression-value-fact.js';

export type RunProgressionSemanticRequest =
  | {
      readonly kind: 'initialize';
      readonly occurrenceKey: string;
      readonly values: readonly RunProgressionValueFact[];
    }
  | {
      readonly kind: 'task_outcome';
      readonly nodeKey: string;
      readonly outcome:
        | { readonly kind: 'succeeded'; readonly values: readonly RunProgressionValueFact[] }
        | { readonly kind: 'failed'; readonly faultCode: string; readonly faultMessage: string }
        | { readonly kind: 'cancelled' }
        | { readonly kind: 'skipped' };
    }
  | {
      readonly kind: 'consensus_verdict';
      readonly nodeKey: string;
      readonly candidateKey: string;
      readonly verdict: 'approve' | 'reject' | 'abstain';
    }
  | {
      readonly kind: 'human_gate_resolution';
      readonly nodeKey: string;
      readonly activationId: string;
      readonly resolution: string;
      readonly values: readonly RunProgressionValueFact[];
    };
