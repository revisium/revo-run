import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import type { JsonValue } from '../../contracts/json-value.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { PipelineInputScope } from '../../contracts/pipeline/pipeline-input.js';
import type { RecoveryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';

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
}

export type ExecuteNodeEffect = (
  request: RunExecutorRequest,
  timeoutMs: number,
  recovery: RecoveryPolicy,
  nextReconciliationRound: number,
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
>;

export type WaitForRetry = (delayMs: number) => Promise<void>;
