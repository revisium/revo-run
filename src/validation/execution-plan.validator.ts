import Schema from 'typebox/schema';

import { pipelineNodePath } from '../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../contracts/pipeline/pipeline-node.js';
import { ExecutionPlanSchema } from '../contracts/run/execution-plan.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';

const schemaValidator = Schema.Compile(ExecutionPlanSchema);

export type ExecutionPlanValidationErrorCode =
  | 'binding_target_not_found'
  | 'binding_target_not_task'
  | 'duplicate_executor_binding'
  | 'duplicate_node_path'
  | 'invalid_execution_plan'
  | 'missing_executor_binding'
  | 'node_depth_exceeded'
  | 'pipeline_not_found'
  | 'root_pipeline_not_found'
  | 'subpipeline_cycle'
  | 'subpipeline_depth_exceeded';

export type ExecutionPlanValidationResult =
  | { readonly valid: true; readonly plan: ExecutionPlan }
  | { readonly valid: false; readonly code: ExecutionPlanValidationErrorCode };

type PipelineInspection =
  | {
      readonly valid: true;
      readonly dependencies: ReadonlySet<string>;
      readonly nodeKinds: ReadonlyMap<string, PipelineNode['kind']>;
    }
  | {
      readonly valid: false;
      readonly code: 'duplicate_node_path' | 'node_depth_exceeded';
    };

type PipelineGraphInspection =
  | {
      readonly valid: true;
      readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
      readonly nodeKinds: ReadonlyMap<string, ReadonlyMap<string, PipelineNode['kind']>>;
    }
  | {
      readonly valid: false;
      readonly code: 'duplicate_node_path' | 'node_depth_exceeded' | 'pipeline_not_found';
    };

const optionalNode = (node: PipelineNode | undefined): readonly PipelineNode[] =>
  node === undefined ? [] : [node];

const childNodes = (node: PipelineNode): readonly PipelineNode[] => {
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

const inspectPipeline = (root: PipelineNode, maximumDepth: number): PipelineInspection => {
  const dependencies = new Set<string>();
  const nodeKinds = new Map<string, PipelineNode['kind']>();
  const pending: Array<{
    readonly node: PipelineNode;
    readonly depth: number;
    readonly parentPath: string;
  }> = [{ node: root, depth: 1, parentPath: '' }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    if (current.depth > maximumDepth) {
      return { valid: false, code: 'node_depth_exceeded' };
    }
    const path = pipelineNodePath(current.node, current.parentPath);
    if (path !== current.parentPath && nodeKinds.has(path)) {
      return { valid: false, code: 'duplicate_node_path' };
    }
    if (path !== current.parentPath) {
      nodeKinds.set(path, current.node.kind);
    }
    if (current.node.kind === 'subpipeline') {
      dependencies.add(current.node.pipelineId);
    }
    for (const child of childNodes(current.node)) {
      pending.push({ node: child, depth: current.depth + 1, parentPath: path });
    }
  }

  return { valid: true, dependencies, nodeKinds };
};

const inspectPipelineGraph = (plan: ExecutionPlan): PipelineGraphInspection => {
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

const bindingKey = (pipelineId: string, nodePath: string): string => `${pipelineId}\0${nodePath}`;

const validateBindings = (
  plan: ExecutionPlan,
  nodeKinds: ReadonlyMap<string, ReadonlyMap<string, PipelineNode['kind']>>,
): ExecutionPlanValidationErrorCode | undefined => {
  const bindingTargets = new Set<string>();

  for (const { target } of plan.bindings) {
    const targetKey = bindingKey(target.pipelineId, target.nodePath);
    if (bindingTargets.has(targetKey)) {
      return 'duplicate_executor_binding';
    }

    bindingTargets.add(targetKey);
  }

  for (const { target } of plan.bindings) {
    const kind = nodeKinds.get(target.pipelineId)?.get(target.nodePath);
    if (kind === undefined) {
      return 'binding_target_not_found';
    }
    if (kind !== 'task') {
      return 'binding_target_not_task';
    }
  }

  for (const [pipelineId, pipelineNodeKinds] of nodeKinds) {
    for (const [nodePath, kind] of pipelineNodeKinds) {
      if (kind === 'task' && !bindingTargets.has(bindingKey(pipelineId, nodePath))) {
        return 'missing_executor_binding';
      }
    }
  }

  return undefined;
};

const topologicalOrder = (
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] | undefined => {
  const incomingEdges = new Map<string, number>();
  for (const pipelineId of dependencies.keys()) {
    incomingEdges.set(pipelineId, 0);
  }
  for (const pipelineDependencies of dependencies.values()) {
    for (const dependency of pipelineDependencies) {
      incomingEdges.set(dependency, (incomingEdges.get(dependency) ?? 0) + 1);
    }
  }

  const ready = [...incomingEdges]
    .filter(([, count]) => count === 0)
    .map(([pipelineId]) => pipelineId);
  const order: string[] = [];

  while (ready.length > 0) {
    const pipelineId = ready.pop();
    if (pipelineId === undefined) {
      continue;
    }
    order.push(pipelineId);

    for (const dependency of dependencies.get(pipelineId) ?? []) {
      const remainingEdges = (incomingEdges.get(dependency) ?? 0) - 1;
      incomingEdges.set(dependency, remainingEdges);
      if (remainingEdges === 0) {
        ready.push(dependency);
      }
    }
  }

  return order.length === dependencies.size ? order : undefined;
};

const respectsSubpipelineDepth = (
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  order: readonly string[],
  maximumDepth: number,
): boolean => {
  const depths = new Map<string, number>();

  for (const pipelineId of order) {
    const pipelineDepth = depths.get(pipelineId) ?? 1;
    for (const dependency of dependencies.get(pipelineId) ?? []) {
      const dependencyDepth = Math.max(depths.get(dependency) ?? 1, pipelineDepth + 1);
      if (dependencyDepth > maximumDepth) {
        return false;
      }
      depths.set(dependency, dependencyDepth);
    }
  }

  return true;
};

const validateSemantics = (plan: ExecutionPlan): ExecutionPlanValidationResult => {
  if (!Object.hasOwn(plan.pipelines, plan.rootPipelineId)) {
    return { valid: false, code: 'root_pipeline_not_found' };
  }

  const graph = inspectPipelineGraph(plan);
  if (!graph.valid) {
    return graph;
  }

  const bindingError = validateBindings(plan, graph.nodeKinds);
  if (bindingError !== undefined) {
    return { valid: false, code: bindingError };
  }

  const order = topologicalOrder(graph.dependencies);
  if (order === undefined) {
    return { valid: false, code: 'subpipeline_cycle' };
  }
  if (!respectsSubpipelineDepth(graph.dependencies, order, plan.policies.maximumSubpipelineDepth)) {
    return { valid: false, code: 'subpipeline_depth_exceeded' };
  }

  return { valid: true, plan };
};

const validate = (value: unknown): ExecutionPlanValidationResult => {
  if (!schemaValidator.Check(value)) {
    return { valid: false, code: 'invalid_execution_plan' };
  }

  return validateSemantics(value);
};

export const ExecutionPlanValidator = {
  Check(value: unknown): value is ExecutionPlan {
    return validate(value).valid;
  },
  Validate: validate,
};
