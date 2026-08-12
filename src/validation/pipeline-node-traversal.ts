import type { PipelineNode } from '../contracts/pipeline/pipeline-node.js';

const optionalNode = (node: PipelineNode | undefined): readonly PipelineNode[] =>
  node === undefined ? [] : [node];

export const pipelineChildNodes = (node: PipelineNode): readonly PipelineNode[] => {
  switch (node.kind) {
    case 'branch':
      return [...Object.values(node.cases), ...optionalNode(node.default)];
    case 'consensus':
      return Object.values(node.participants);
    case 'map':
    case 'repeat':
      return [node.body];
    case 'outcomeSwitch':
      return [node.source, ...Object.values(node.cases), ...optionalNode(node.default)];
    case 'parallel':
      return Object.values(node.branches);
    case 'sequence':
      return node.children;
    case 'delay':
    case 'end':
    case 'humanGate':
    case 'subpipeline':
    case 'task':
      return [];
  }

  node satisfies never;
  return node;
};

export const pipelineNodes = (roots: readonly PipelineNode[]): readonly PipelineNode[] => {
  const nodes: PipelineNode[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    nodes.push(node);
    pending.push(...pipelineChildNodes(node));
  }
  return nodes;
};
