import type { ExecutionPlanPin } from './execution-plan-pin.js';
import type { JsonValue } from './json-value.js';
import type { RunExecutionPlanExecutorBinding } from './run-execution-plan-executor-binding.js';
import type { RunExecutionPlanTerminalBinding } from './run-execution-plan-terminal-binding.js';

export interface RunExecutionPlanDocument {
  readonly pin: ExecutionPlanPin;
  readonly compiledPipeline: JsonValue;
  readonly executorBindings: readonly RunExecutionPlanExecutorBinding[];
  readonly terminalBindings: readonly RunExecutionPlanTerminalBinding[];
}
