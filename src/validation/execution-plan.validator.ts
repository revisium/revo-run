import Schema from 'typebox/schema';

import type { PipelineNode } from '../contracts/pipeline/pipeline-node.js';
import { ExecutionPlanSchema } from '../contracts/run/execution-plan.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';
import { executionPlanFitsBound } from './execution-plan-bound.js';
import { inspectPipelineGraph } from './execution-plan-graph.js';
import { classifyExecutionPlanSchemaFailure } from './execution-plan-schema-failure.js';

const schemaValidator = Schema.Compile(ExecutionPlanSchema);

export type ExecutionPlanValidationErrorCode =
  | 'binding_target_not_found'
  | 'binding_target_not_task'
  | 'duplicate_executor_binding'
  | 'duplicate_node_key'
  | 'execution_bound_exceeded'
  | 'invalid_node_key'
  | 'invalid_pipeline_id'
  | 'invalid_repeat_bound'
  | 'invalid_execution_plan'
  | 'missing_branch_default'
  | 'missing_executor_binding'
  | 'node_depth_exceeded'
  | 'overlapping_repeat_outcome_sets'
  | 'pipeline_not_found'
  | 'root_pipeline_not_found'
  | 'subpipeline_cycle'
  | 'subpipeline_depth_exceeded'
  | 'unsupported_plan_schema_version'
  | 'unreachable_consensus_threshold'
  | 'unreachable_parallel_threshold';

export type ExecutionPlanValidationResult =
  | { readonly valid: true; readonly plan: ExecutionPlan }
  | { readonly valid: false; readonly code: ExecutionPlanValidationErrorCode };

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
  if (!executionPlanFitsBound(plan)) {
    return { valid: false, code: 'execution_bound_exceeded' };
  }

  return { valid: true, plan };
};

const validate = (value: unknown): ExecutionPlanValidationResult => {
  if (!schemaValidator.Check(value)) {
    return { valid: false, code: classifyExecutionPlanSchemaFailure(value) };
  }

  return validateSemantics(value);
};

export const ExecutionPlanValidator = {
  Check(value: unknown): value is ExecutionPlan {
    return validate(value).valid;
  },
  Validate: validate,
};
