import type { ExecutorInput } from '../../contracts/executor/executor-input.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { RepeatNode } from '../../contracts/pipeline/pipeline-node.js';
import type { RepeatIterationResult } from '../../contracts/workflow/repeat-iteration-result.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';
import type { PipelineExecutionContext } from '../interpreter/interpreter-context.js';

export interface RepeatIterationExecution {
  readonly node: RepeatNode;
  readonly context: PipelineExecutionContext;
  readonly nodePath: string;
  readonly ordinal: number;
  readonly input: ExecutorInput;
}

export type RepeatIterationExecutionResult = RepeatIterationResult;

export type RepeatIterationBodyResult =
  | {
      readonly kind: 'continued';
      readonly outcome: string;
      readonly output?: NodeOutput;
    }
  | { readonly kind: 'terminal'; readonly result: TerminalWorkflowResult };

export interface RepeatIterationRunner {
  execute(input: RepeatIterationExecution): Promise<RepeatIterationExecutionResult>;
}
