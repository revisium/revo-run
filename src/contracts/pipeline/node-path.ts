import { NonEmptyStringSchema } from '../schema-primitives.js';
import type { PipelineNode } from './pipeline-node.js';

export const RunNodePathSchema = NonEmptyStringSchema;

export const childNodePath = (parent: string, child: string): string =>
  parent.length === 0 ? child : `${parent}/${child}`;

export const pipelineNodePath = (node: PipelineNode, parent: string): string => {
  switch (node.kind) {
    case 'end':
    case 'outcomeSwitch':
    case 'sequence':
      return parent;
    case 'branch':
    case 'consensus':
    case 'delay':
    case 'humanGate':
    case 'map':
    case 'parallel':
    case 'repeat':
    case 'subpipeline':
    case 'task':
      return childNodePath(parent, node.key);
  }

  node satisfies never;
  return node;
};
