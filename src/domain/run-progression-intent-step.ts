import type { Attempt } from './attempt.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';

type ActivationCause =
  | { readonly kind: 'entry' }
  | {
      readonly kind: 'successor';
      readonly predecessorNodeKey: string;
      readonly predecessorActivationId: string;
    }
  | {
      readonly kind: 'fork';
      readonly predecessorNodeKey: string;
      readonly predecessorActivationId: string;
      readonly forkNodeKey: string;
      readonly forkActivationId: string;
      readonly branchKey: string | null;
      readonly relation: 'entry' | 'member' | 'exit' | 'join';
    };

type Retirement = {
  readonly node: RunNodeInstance;
  readonly attempt: Attempt | null;
};

export type RunProgressionIntentStep =
  | { readonly kind: 'initialize' }
  | {
      readonly kind: 'complete_task';
      readonly nodeKey: string;
      readonly outcome: string;
      readonly node: RunNodeInstance;
      readonly attempt: Attempt | null;
      readonly outputs: readonly RunOutput[];
    }
  | {
      readonly kind: 'record_verdict';
      readonly nodeKey: string;
      readonly candidateKey: string;
    }
  | {
      readonly kind: 'resolve_gate';
      readonly nodeKey: string;
      readonly node: RunNodeInstance;
      readonly output: RunOutput;
    }
  | {
      readonly kind: 'complete_selector';
      readonly nodeKey: string;
      readonly outcome: string;
      readonly node: RunNodeInstance;
    }
  | {
      readonly kind: 'complete_join';
      readonly nodeKey: string;
      readonly outcome: string;
      readonly node: RunNodeInstance;
    }
  | {
      readonly kind: 'activate_node';
      readonly nodeKey: string;
      readonly nodeKind: 'task' | 'human_gate' | 'join' | 'selector';
      readonly cause: ActivationCause;
      readonly node: RunNodeInstance;
    }
  | {
      readonly kind: 'terminate';
      readonly nodeKey: string;
      readonly outcome: string;
      readonly retirements: readonly Retirement[];
    }
  | {
      readonly kind: 'settle_retired_attempt';
      readonly nodeKey: string;
      readonly attemptId: string;
      readonly node: RunNodeInstance;
      readonly attempt: Attempt;
    };
