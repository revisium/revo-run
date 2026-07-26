import type { ActivationKey, ForkScopeKey } from '../spec/index.js';
import type { AttemptCorrelation } from './attempt-correlation.js';
import type { AttemptTransitionPayload } from './attempt-transition-payload.js';
import type { NodeCorrelation } from './node-correlation.js';
import type { NodeTransitionCause } from './node-transition-cause.js';
import type { RunCorrelation } from './run-correlation.js';
import type { RunNodeStatus } from './run-node-status.js';

export type RunEventIntent =
  | {
      readonly runId: string;
      readonly kind: 'run.transitioned';
      readonly correlation: { readonly kind: 'run' };
      readonly payload: {
        readonly from: 'running';
        readonly to: 'cancelling';
        readonly cause: 'cancellation_requested';
      };
    }
  | {
      readonly runId: string;
      readonly kind: 'node.activated';
      readonly correlation: NodeCorrelation;
      readonly payload: {
        readonly nodeKey: string;
        readonly status: 'ready' | 'gate_waiting' | 'join_waiting';
        readonly activationKey: ActivationKey;
        readonly forkScopeKey: ForkScopeKey;
        readonly branchKey: string | null;
        readonly iteration: number;
      };
    }
  | {
      readonly runId: string;
      readonly kind: 'node.transitioned';
      readonly correlation: NodeCorrelation;
      readonly payload: {
        readonly from: RunNodeStatus;
        readonly to: RunNodeStatus;
        readonly cause: NodeTransitionCause;
      };
    }
  | {
      readonly runId: string;
      readonly kind: 'attempt.created';
      readonly correlation: AttemptCorrelation;
      readonly payload: {
        readonly status: 'claimed';
        readonly ordinal: number;
        readonly managerIncarnationId: string;
        readonly fencingToken: number;
      };
    }
  | {
      readonly runId: string;
      readonly kind: 'attempt.transitioned';
      readonly correlation: AttemptCorrelation;
      readonly payload: AttemptTransitionPayload;
    }
  | {
      readonly runId: string;
      readonly kind: 'output.recorded';
      readonly correlation: RunCorrelation;
      readonly payload: {
        readonly outputId: string;
        readonly name: string;
        readonly payloadKind: 'json' | 'artifact';
      };
    };
