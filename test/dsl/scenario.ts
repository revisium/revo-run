import type { ConsensusVote } from '../../src/contracts/pipeline/pipeline-progress.js';
import type {
  ExecutionPlan,
  JsonValue,
  NodeOutput,
  OutputValue,
  RunNodeExecutionStatus,
} from '../../src/index.js';
import type {
  RequiredScenarioCapabilities,
  ScenarioCategory,
  ScenarioIntentId,
} from './scenario-capability.js';

export interface RunScenario {
  readonly intentId: ScenarioIntentId;
  readonly category: ScenarioCategory;
  readonly name: string;
  readonly requiredCapabilities: RequiredScenarioCapabilities;
  readonly plan: ExecutionPlan;
  readonly steps: readonly ScenarioStep[];
}

export interface ExpectedRunEvent {
  readonly type: string;
  readonly path?: string;
  readonly errorCode?: string;
  readonly captureCursorAs?: string;
}

export type ScenarioStep =
  | {
      readonly kind: 'startRun';
      readonly input: JsonValue;
      readonly planSchemaVersionOverride?: number;
    }
  | {
      readonly kind: 'expectNodeExecutions';
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'expectAgentExecution';
      readonly path: string;
      readonly roleId: string;
    }
  | {
      readonly kind: 'expectVersionedScriptExecution';
      readonly path: string;
      readonly scriptId: string;
      readonly revision: number;
    }
  | {
      readonly kind: 'expectNodeInput';
      readonly path: string;
      readonly value: JsonValue;
    }
  | {
      readonly kind: 'expectNoNodeExecution';
      readonly path: string;
    }
  | {
      readonly kind: 'completeNode';
      readonly path: string;
      readonly attempt: number;
      readonly outcome: string;
      readonly output?: NodeOutput;
    }
  | {
      readonly kind: 'failNode';
      readonly path: string;
      readonly attempt: number;
      readonly errorCode: string;
    }
  | {
      readonly kind: 'failInputResolution';
      readonly path: string;
      readonly errorCode: string;
    }
  | {
      readonly kind: 'reconcileNode';
      readonly path: string;
      readonly result:
        | 'effectCompleted'
        | 'effectFailed'
        | 'effectNotFound'
        | 'outcomeUnknown'
        | 'reconciliationFailed';
      readonly output?: NodeOutput;
    }
  | {
      readonly kind: 'completeConsensusParticipant';
      readonly vote: ConsensusVote;
    }
  | {
      readonly kind: 'answerHumanGate';
      readonly path: string;
      readonly answer: string;
      readonly actorId: string;
      readonly actorGroups: readonly string[];
      readonly commandId: string;
    }
  | {
      readonly kind: 'expectCommandResult';
      readonly result: ScenarioCommandResult;
    }
  | {
      readonly kind: 'expectHumanGateWaiting';
      readonly path: string;
    }
  | {
      readonly kind: 'expectIteration';
      readonly path: string;
      readonly iteration: number;
    }
  | {
      readonly kind: 'advanceTime';
      readonly durationMs: number;
    }
  | {
      readonly kind: 'crashManager';
      readonly moment: 'afterEffect' | 'beforeEffect' | 'whileWaiting';
    }
  | { readonly kind: 'restartManager' }
  | { readonly kind: 'cancelRun'; readonly actorId: string }
  | {
      readonly kind: 'resolveUnknownOutcome';
      readonly attemptCapture: string;
      readonly resolution:
        | { readonly kind: 'adoptSuccess'; readonly outcome: string; readonly output?: NodeOutput }
        | { readonly kind: 'markFailed' }
        | { readonly kind: 'retry' };
      readonly actorId: string;
    }
  | { readonly kind: 'captureAttemptId'; readonly path: string; readonly captureAs: string }
  | { readonly kind: 'expectExecutorAborted'; readonly path: string }
  | { readonly kind: 'ignoreExecutorAbort'; readonly path: string }
  | { readonly kind: 'captureRunState'; readonly captureAs: string }
  | { readonly kind: 'expectRunStateUnchanged'; readonly capture: string }
  | {
      readonly kind: 'expectResolutionDetails';
      readonly attemptCapture: string;
      readonly actorId: string;
      readonly resolutionKind: 'adoptSuccess' | 'markFailed' | 'retry';
      readonly outcome?: string;
      readonly nodeStatus: RunNodeExecutionStatus;
    }
  | {
      readonly kind: 'expectScopeStatuses';
      readonly paths: readonly string[];
      readonly status: 'cancelled';
    }
  | { readonly kind: 'expectNoActiveDurableScopes' }
  | { readonly kind: 'expectDistinctCommandIds'; readonly captures: readonly string[] }
  | {
      readonly kind: 'expectRunStatus';
      readonly status: 'cancelled' | 'failed' | 'running' | 'succeeded';
      readonly withinMs?: number;
    }
  | {
      readonly kind: 'expectOutputValue';
      readonly path: string;
      readonly outputKey: string;
      readonly value: OutputValue;
    }
  | {
      readonly kind: 'expectJsonOutput';
      readonly path: string;
      readonly outputKey: string;
      readonly pointer?: string;
      readonly value: JsonValue;
    }
  | {
      readonly kind: 'expectEvent';
      readonly event: ExpectedRunEvent;
    }
  | {
      readonly kind: 'resumeSubscription';
      readonly afterCapturedCursor: string;
    }
  | {
      readonly kind: 'captureCursorFromAnotherRun';
      readonly captureAs: string;
    }
  | {
      readonly kind: 'expectNoDuplicateExecution';
      readonly path: string;
    }
  | {
      readonly kind: 'expectExecutionCount';
      readonly path: string;
      readonly count: number;
    }
  | {
      readonly kind: 'expectMaximumActiveExecutions';
      readonly count: number;
    }
  | {
      readonly kind: 'expectSecretAbsent';
      readonly value: string;
    }
  | {
      readonly kind: 'expectSecretResolved';
      readonly value: string;
    }
  | {
      readonly kind: 'expectRunDetails';
      readonly nodePaths: readonly string[];
      readonly scopePaths?: readonly string[];
      readonly attempts?: readonly {
        readonly nodePath: string;
        readonly ordinal: number;
        readonly status: RunNodeExecutionStatus;
      }[];
    }
  | {
      readonly kind: 'expectPlanRejected';
      readonly errorCode: string;
    }
  | {
      readonly kind: 'expectSubscriptionError';
      readonly errorCode: string;
    }
  | {
      readonly kind: 'expectCursorOrder';
      readonly cursors: readonly string[];
    };

export const scenario = (value: RunScenario): RunScenario => value;

export type ScenarioCommandResult =
  | { readonly status: 'accepted'; readonly captureCommandIdAs?: string }
  | {
      readonly status: 'rejected';
      readonly reason: ScenarioCommandRejectionReason;
      readonly captureCommandIdAs?: string;
    };

export type ScenarioCommandRejectionReason =
  | 'actor_already_answered'
  | 'actor_not_eligible'
  | 'gate_already_resolved'
  | 'invalid_gate_answer'
  | 'run_already_terminal'
  | 'run_cancellation_requested'
  | 'unknown_outcome_not_pending'
  | 'unknown_outcome_already_resolved'
  | 'unknown_outcome_retry_not_permitted';
