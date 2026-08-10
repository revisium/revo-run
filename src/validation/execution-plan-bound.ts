import type { PipelineNode } from '../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';

const add = (left: number, right: number, limit: number): number | undefined =>
  left > limit - right ? undefined : left + right;

const multiply = (left: number, right: number, limit: number): number | undefined =>
  left > Math.floor(limit / right) ? undefined : left * right;

const maximum = (values: readonly (number | undefined)[]): number | undefined => {
  let result = 0;
  for (const value of values) {
    if (value === undefined) {
      return undefined;
    }
    result = Math.max(result, value);
  }
  return result;
};

const sum = (values: readonly (number | undefined)[], limit: number): number | undefined => {
  let result = 0;
  for (const value of values) {
    if (value === undefined) {
      return undefined;
    }
    const next = add(result, value, limit);
    if (next === undefined) {
      return undefined;
    }
    result = next;
  }
  return result;
};

export const executionPlanFitsBound = (plan: ExecutionPlan): boolean => {
  const limit = plan.policies.maximumTotalNodeExecutions;
  const memo = new Map<string, number>();

  const pipelineBound = (pipelineId: string): number | undefined => {
    const cached = memo.get(pipelineId);
    if (cached !== undefined) {
      return cached;
    }
    const pipeline = plan.pipelines[pipelineId];
    if (pipeline === undefined) {
      return undefined;
    }
    const bound = nodeBound(pipeline.root);
    if (bound !== undefined) {
      memo.set(pipelineId, bound);
    }
    return bound;
  };

  const nodeBound = (node: PipelineNode): number | undefined => {
    switch (node.kind) {
      case 'task':
        return node.retry?.maximumAttempts ?? 1;
      case 'sequence':
        return sum(node.children.map(nodeBound), limit);
      case 'outcomeSwitch': {
        const source = nodeBound(node.source);
        const route = maximum([
          ...Object.values(node.cases).map(nodeBound),
          ...(node.default === undefined ? [] : [nodeBound(node.default)]),
        ]);
        return source === undefined || route === undefined ? undefined : add(source, route, limit);
      }
      case 'branch':
        return maximum([
          ...Object.values(node.cases).map(nodeBound),
          ...(node.default === undefined ? [] : [nodeBound(node.default)]),
        ]);
      case 'parallel':
        return sum(Object.values(node.branches).map(nodeBound), limit);
      case 'consensus':
        return sum(Object.values(node.participants).map(nodeBound), limit);
      case 'repeat': {
        const body = nodeBound(node.body);
        return body === undefined ? undefined : multiply(node.maximumIterations, body, limit);
      }
      case 'map': {
        const body = nodeBound(node.body);
        return body === undefined ? undefined : multiply(node.maximumItems, body, limit);
      }
      case 'subpipeline':
        return pipelineBound(node.pipelineId);
      case 'delay':
      case 'end':
      case 'humanGate':
        return 0;
    }

    node satisfies never;
    return node;
  };

  const rootBound = pipelineBound(plan.rootPipelineId);
  return rootBound !== undefined && rootBound <= limit;
};
