import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';

export type NodeExecutionResult =
  | {
      readonly kind: 'continued';
      readonly outcome: string;
      readonly path: string;
      readonly output?: NodeOutput;
    }
  | {
      readonly kind: 'finished';
      readonly result: RunWorkflowResult;
    };

export const continuedExecution = (
  outcome: string,
  path: string,
  output?: NodeOutput,
): NodeExecutionResult => ({
  kind: 'continued',
  outcome,
  path,
  ...(output === undefined ? {} : { output }),
});
