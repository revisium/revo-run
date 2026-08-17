import type { JsonValue } from '../../contracts/json-value.js';
import type { MapNodeOutput } from '../../contracts/pipeline/map-output.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { MapNode } from '../../contracts/pipeline/pipeline-node.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';
import type { PipelineExecutionContext } from '../interpreter/interpreter-context.js';

export interface PreparedMapItem {
  readonly sourceIndex: number;
  readonly itemKey: string;
  readonly value: JsonValue;
}

export interface MapItemExecution {
  readonly node: MapNode;
  readonly context: PipelineExecutionContext;
  readonly nodePath: string;
  readonly items: readonly PreparedMapItem[];
}

export type MapItemExecutionResult =
  | {
      readonly kind: 'continued';
      readonly outcome: 'completed' | 'completedWithErrors' | 'failed';
      readonly output: MapNodeOutput;
    }
  | { readonly kind: 'terminal'; readonly result: TerminalWorkflowResult };

export interface MapItemRunner {
  execute(input: MapItemExecution): Promise<MapItemExecutionResult>;
}

export type MapItemBodyResult =
  | {
      readonly kind: 'continued';
      readonly outcome: string;
      readonly output?: NodeOutput;
    }
  | { readonly kind: 'authoredEnd'; readonly result: RunWorkflowResult }
  | { readonly kind: 'terminal'; readonly result: TerminalWorkflowResult };
