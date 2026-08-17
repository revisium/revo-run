import type { ExecutorInput } from '../../contracts/executor/executor-input.js';
import type { JsonValue } from '../../contracts/json-value.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { PipelineInputScope } from '../../contracts/pipeline/pipeline-input.js';
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
  readonly nodePathPrefix?: string;
  readonly iterationInput?: ExecutorInput;
  readonly iterationOutput?: NodeOutput;
  readonly mapItem?: JsonValue;
}
