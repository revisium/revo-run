import { pipelineNodePath } from '../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';
import { pipelineChildNodes } from './pipeline-node-traversal.js';

type PipelineGraphErrorCode =
  | 'duplicate_node_key'
  | 'missing_branch_default'
  | 'node_depth_exceeded'
  | 'overlapping_repeat_outcome_sets'
  | 'pipeline_not_found'
  | 'unreachable_consensus_threshold'
  | 'unreachable_parallel_threshold';

export type PipelineGraphInspection =
  | {
      readonly valid: true;
      readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
      readonly nodeKinds: ReadonlyMap<string, ReadonlyMap<string, PipelineNode['kind']>>;
    }
  | { readonly valid: false; readonly code: PipelineGraphErrorCode };

type PipelineInspection =
  | {
      readonly valid: true;
      readonly dependencies: ReadonlySet<string>;
      readonly nodeKinds: ReadonlyMap<string, PipelineNode['kind']>;
    }
  | { readonly valid: false; readonly code: Exclude<PipelineGraphErrorCode, 'pipeline_not_found'> };

const nodeValidationError = (
  node: PipelineNode,
):
  | Exclude<
      PipelineGraphErrorCode,
      'duplicate_node_key' | 'node_depth_exceeded' | 'pipeline_not_found'
    >
  | undefined => {
  if (node.kind === 'branch' && node.default === undefined) {
    return 'missing_branch_default';
  }
  if (
    node.kind === 'parallel' &&
    node.join.kind === 'threshold' &&
    node.join.count > Object.keys(node.branches).length
  ) {
    return 'unreachable_parallel_threshold';
  }
  if (node.kind === 'consensus') {
    const participants = Object.keys(node.participants).length;
    if (
      (node.policy.kind === 'quorum' && node.policy.count > participants) ||
      (node.policy.kind === 'threshold' &&
        (node.policy.approve > participants || node.policy.reject > participants))
    ) {
      return 'unreachable_consensus_threshold';
    }
  }
  if (
    node.kind === 'repeat' &&
    node.continueOn.some((outcome) => node.completeOn.includes(outcome))
  ) {
    return 'overlapping_repeat_outcome_sets';
  }
  return undefined;
};

interface PendingPipelineNode {
  readonly node: PipelineNode;
  readonly depth: number;
  readonly parentPath: string;
}

type PipelineNodeInspection =
  | { readonly valid: true; readonly path: string }
  | Extract<PipelineInspection, { readonly valid: false }>;

const inspectPipelineNode = (
  current: PendingPipelineNode,
  maximumDepth: number,
  dependencies: Set<string>,
  nodeKinds: Map<string, PipelineNode['kind']>,
): PipelineNodeInspection => {
  if (current.depth > maximumDepth) {
    return { valid: false, code: 'node_depth_exceeded' };
  }

  const path = pipelineNodePath(current.node, current.parentPath);
  if (path !== current.parentPath && nodeKinds.has(path)) {
    return { valid: false, code: 'duplicate_node_key' };
  }
  if (path !== current.parentPath) {
    nodeKinds.set(path, current.node.kind);
  }
  if (current.node.kind === 'subpipeline') {
    dependencies.add(current.node.pipelineId);
  }
  const validationError = nodeValidationError(current.node);
  return validationError === undefined
    ? { valid: true, path }
    : { valid: false, code: validationError };
};

const inspectPipeline = (root: PipelineNode, maximumDepth: number): PipelineInspection => {
  const dependencies = new Set<string>();
  const nodeKinds = new Map<string, PipelineNode['kind']>();
  const pending: PendingPipelineNode[] = [{ node: root, depth: 1, parentPath: '' }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    const inspection = inspectPipelineNode(current, maximumDepth, dependencies, nodeKinds);
    if (!inspection.valid) {
      return inspection;
    }
    for (const child of pipelineChildNodes(current.node)) {
      pending.push({ node: child, depth: current.depth + 1, parentPath: inspection.path });
    }
  }

  return { valid: true, dependencies, nodeKinds };
};

export const inspectPipelineGraph = (plan: ExecutionPlan): PipelineGraphInspection => {
  const dependencies = new Map<string, ReadonlySet<string>>();
  const nodeKinds = new Map<string, ReadonlyMap<string, PipelineNode['kind']>>();

  for (const [pipelineId, pipeline] of Object.entries(plan.pipelines)) {
    const inspection = inspectPipeline(pipeline.root, plan.policies.maximumNodeNestingDepth);
    if (!inspection.valid) {
      return inspection;
    }
    for (const dependency of inspection.dependencies) {
      if (!Object.hasOwn(plan.pipelines, dependency)) {
        return { valid: false, code: 'pipeline_not_found' };
      }
    }
    dependencies.set(pipelineId, inspection.dependencies);
    nodeKinds.set(pipelineId, inspection.nodeKinds);
  }

  return { valid: true, dependencies, nodeKinds };
};
