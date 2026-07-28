type AppliedOutcome =
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'terminal';
      readonly terminal:
        | {
            readonly nodeKey: string;
            readonly outcome: string;
            readonly status: 'succeeded' | 'cancelled';
            readonly fault: null;
          }
        | {
            readonly nodeKey: string;
            readonly outcome: string;
            readonly status: 'failed';
            readonly fault: {
              readonly code: 'PIPELINE_TERMINAL';
              readonly message: string;
            };
          };
    };

export type RunProgressionAppliedReceipt = {
  readonly schemaVersion: 1;
  readonly application: 'applied';
  readonly operation:
    | 'initialize'
    | 'task_outcome'
    | 'consensus_verdict'
    | 'human_gate_resolution'
    | 'retired_attempt_observation';
  readonly occurrenceKey: string;
  readonly outcome: AppliedOutcome;
  readonly attemptObservation?: {
    readonly attemptId: string;
    readonly nodeKey: string;
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly fault: { readonly code: ExecutorFailureFaultCode; readonly message: string } | null;
    readonly terminalAt: number;
  };
};
import type { ExecutorFailureFaultCode } from '../errors/index.js';
