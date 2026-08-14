import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';

export type NodeExecutionResult =
  | {
      readonly kind: 'continued';
      readonly outcome: string;
      readonly path: string;
      readonly output?: NodeOutput;
    }
  | {
      readonly kind: 'finished';
      readonly provenance: 'authoredEnd';
      readonly result: RunWorkflowResult;
    }
  | {
      readonly kind: 'finished';
      readonly provenance: 'terminal';
      readonly result: TerminalWorkflowResult;
    };

export type FinishedNodeExecutionResult = Extract<
  NodeExecutionResult,
  { readonly kind: 'finished' }
>;

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

export const terminalExecution = (result: TerminalWorkflowResult): FinishedNodeExecutionResult => ({
  kind: 'finished',
  provenance: 'terminal',
  result,
});

export const authoredEndExecution = (result: RunWorkflowResult): FinishedNodeExecutionResult => ({
  kind: 'finished',
  provenance: 'authoredEnd',
  result,
});
