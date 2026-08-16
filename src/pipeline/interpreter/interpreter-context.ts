import type { ExecutorInput } from '../../contracts/executor/executor-input.js';
import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import type { JsonValue } from '../../contracts/json-value.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { PipelineInputScope } from '../../contracts/pipeline/pipeline-input.js';
import type {
  ConsensusNode,
  ConsensusPolicy,
  HumanGateNode,
} from '../../contracts/pipeline/pipeline-node.js';
import type { RecoveryPolicy, RetryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { ConsensusResolutionDirective } from '../../contracts/workflow/consensus-resolution.js';

export interface PipelineExecutionContext {
  readonly plan: ExecutionPlan;
  readonly runId: string;
  readonly scopeId: string;
  readonly runInput: JsonValue;
  readonly pipelineId: string;
  readonly pipelineInput: PipelineInputScope;
  readonly runtimePath: string;
  readonly outputs: Map<string, NodeOutput>;
  readonly maximumParallelism: number;
  readonly nodePathPrefix?: string;
  readonly iterationInput?: ExecutorInput;
  readonly iterationOutput?: NodeOutput;
  readonly mapItem?: JsonValue;
}

export type DelayWaitResult = 'cancelled' | 'elapsed' | 'failed';

export type WaitForDelay = (durationMs: number) => Promise<DelayWaitResult>;

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

export interface HumanGateWaitRequest {
  readonly gateInstanceId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly answers: readonly string[];
  readonly decision: HumanGateNode['decision'];
  readonly eligibleGroup?: string;
  readonly timeoutMs?: number;
}

export type HumanGateResolution =
  | { readonly kind: 'answered'; readonly answer: string; readonly commandIds: readonly string[] }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'fail' };

export type WaitForHumanGate = (request: HumanGateWaitRequest) => Promise<HumanGateResolution>;

export interface ConsensusParticipantInstance {
  readonly participantId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly nodeInstanceId: string;
  readonly workflowId: string;
}

export interface ConsensusWaitRequest {
  readonly consensusNodeInstanceId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly participantIds: readonly string[];
  readonly participantInstances: readonly ConsensusParticipantInstance[];
  readonly policy: ConsensusPolicy;
  readonly remaining: 'cancel' | 'drain';
  readonly timeoutMs?: number;
}

export type WaitForConsensusResolution = (
  request: ConsensusWaitRequest,
) => Promise<ConsensusResolutionDirective>;

export interface ConsensusParticipantRunner {
  execute(
    node: ConsensusNode,
    context: PipelineExecutionContext,
    nodePath: string,
    wait: WaitForConsensusResolution,
  ): Promise<ConsensusResolutionDirective>;
}

export interface ConsensusExecutionPorts {
  readonly runner: ConsensusParticipantRunner;
  readonly wait: WaitForConsensusResolution;
}
