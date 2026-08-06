import type { ExecutionPlan, JsonValue, NodeOutput, OutputValue } from '../../src/index.js';

export type ScenarioCapability =
  | 'agentExecution'
  | 'cancellation'
  | 'concurrency'
  | 'consensus'
  | 'dataFlow'
  | 'delay'
  | 'humanGate'
  | 'map'
  | 'parallelExecution'
  | 'recovery'
  | 'repeat'
  | 'retry'
  | 'scriptExecution'
  | 'subpipeline'
  | 'subscription'
  | 'validation';

export type ScenarioBlocker = 'pipelineContract' | 'runManagerApi' | 'runRuntime';

export interface RunScenario {
  readonly capability: ScenarioCapability;
  readonly name: string;
  readonly blockedBy?: ScenarioBlocker;
  readonly plan: ExecutionPlan;
  readonly steps: readonly ScenarioStep[];
}

export interface ExpectedRunEvent {
  readonly type: string;
  readonly path?: string;
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
      readonly path: string;
      readonly participantId: string;
      readonly vote: 'abstain' | 'approve' | 'reject';
      readonly executionId: string;
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
      readonly kind: 'expectCommandRejected';
      readonly commandId: string;
      readonly reason: string;
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
  | { readonly kind: 'cancelRun'; readonly actorId: string; readonly commandId: string }
  | {
      readonly kind: 'resolveUnknownOutcome';
      readonly path: string;
      readonly resolution: 'adoptSuccess' | 'markFailed' | 'retry';
      readonly actorId: string;
      readonly commandId: string;
    }
  | {
      readonly kind: 'expectRunStatus';
      readonly status: 'cancelled' | 'failed' | 'running' | 'succeeded';
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
