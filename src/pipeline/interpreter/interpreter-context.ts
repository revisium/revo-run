import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import type { JsonValue } from '../../contracts/json-value.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { PipelineInputScope } from '../data/input-resolver.js';
import type { NodeExecutionBudget } from './node-execution-budget.js';

export interface PipelineExecutionContext {
  readonly plan: ExecutionPlan;
  readonly runId: string;
  readonly runInput: JsonValue;
  readonly pipelineId: string;
  readonly pipelineInput: PipelineInputScope;
  readonly runtimePath: string;
  readonly outputs: Map<string, NodeOutput>;
  readonly executionBudget: NodeExecutionBudget;
}

export type ExecuteNodeEffect = (
  request: RunExecutorRequest,
  timeoutMs: number,
) => Promise<RunNodeExecution | { readonly kind: 'timedOut' }>;
