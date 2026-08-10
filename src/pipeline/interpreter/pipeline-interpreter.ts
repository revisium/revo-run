import { pipelineNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { InputResolver } from '../data/input-resolver.js';
import { createAuthoredNodeId, createSubpipelineScopeId } from '../identity/execution-identity.js';
import type {
  ParallelBranchResult,
  ParallelBranchRunner,
} from '../parallel/parallel-branch-runner.js';
import { ParallelNodeExecutor } from '../parallel/parallel-node-executor.js';
import type { PipelineExecutionContext, ExecuteNodeEffect } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import type { PipelineEventSink } from './pipeline-event-sink.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution } from './pipeline-node-result.js';
import { TaskNodeExecutor } from './task-node-executor.js';

export class PipelineInterpreter {
  private readonly events: PipelineEventSink;
  private readonly parallel: ParallelNodeExecutor;
  private readonly tasks: TaskNodeExecutor;

  constructor(
    executeEffect: ExecuteNodeEffect,
    executeBranches: ParallelBranchRunner,
    events: PipelineEventSink,
  ) {
    this.events = events;
    this.parallel = new ParallelNodeExecutor(executeBranches, events);
    this.tasks = new TaskNodeExecutor(executeEffect, events);
  }

  async execute(
    plan: ExecutionPlan,
    runId: string,
    runInput: PipelineExecutionContext['runInput'],
    scopeId: string,
  ): Promise<RunWorkflowResult> {
    const context: PipelineExecutionContext = {
      plan,
      runId,
      scopeId,
      runInput,
      pipelineId: plan.rootPipelineId,
      pipelineInput: { kind: 'value', value: { kind: 'json', value: runInput } },
      runtimePath: plan.rootPipelineId,
      outputs: new Map(),
      maximumParallelism: plan.policies.maximumActiveNodeExecutions,
    };

    return this.executePipeline(context);
  }

  async executeBranchScope(
    node: PipelineNode,
    context: PipelineExecutionContext,
    parentPath: string,
    branchKey: string,
    inheritedOutputPaths: ReadonlySet<string>,
  ): Promise<ParallelBranchResult> {
    const result = await this.executeNode(node, context, parentPath);

    return {
      key: branchKey,
      outcome: result.kind === 'continued' ? result.outcome : result.result.outcome,
      outputs: [...context.outputs].filter(([path]) => !inheritedOutputPaths.has(path)),
    };
  }

  private async executePipeline(context: PipelineExecutionContext): Promise<RunWorkflowResult> {
    const pipeline = Object.hasOwn(context.plan.pipelines, context.pipelineId)
      ? context.plan.pipelines[context.pipelineId]
      : undefined;
    if (pipeline === undefined) {
      return this.invalid(context.runtimePath, 'pipeline_not_found');
    }

    const result = await this.executeNode(pipeline.root, context, '');
    if (result.kind === 'finished') {
      return result.result;
    }

    return this.invalid(context.runtimePath, 'terminal_not_reached');
  }

  private async executeNode(
    node: PipelineNode,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<NodeExecutionResult> {
    const nodePath = pipelineNodePath(node, parentPath);

    switch (node.kind) {
      case 'task':
        return this.tasks.execute(node, context, nodePath);
      case 'sequence':
        return this.executeSequence(node.children, context, parentPath);
      case 'outcomeSwitch':
        return this.executeOutcomeSwitch(node, context, parentPath);
      case 'branch':
        return this.executeConditionalBranch(node, context, nodePath);
      case 'subpipeline':
        return this.executeSubpipeline(node, context, nodePath);
      case 'parallel':
        return this.parallel.execute(node, context, nodePath);
      case 'end':
        return this.executeEnd(node, context);
      case 'consensus':
      case 'delay':
      case 'humanGate':
      case 'map':
      case 'repeat':
        return this.invalidNode(runtimePath(context, nodePath), 'node_kind_not_implemented');
    }

    node satisfies never;
    return node;
  }

  private async executeSequence(
    children: readonly PipelineNode[],
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<NodeExecutionResult> {
    return this.executeSequenceChild(children, 0, context, parentPath);
  }

  private async executeSequenceChild(
    children: readonly PipelineNode[],
    index: number,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<NodeExecutionResult> {
    const child = children[index];
    if (child === undefined) {
      return continuedExecution('completed', runtimePath(context, parentPath));
    }

    const result = await this.executeNode(child, context, parentPath);
    if (result.kind === 'finished') {
      return result;
    }
    if (result.outcome !== 'completed') {
      return this.invalidNode(result.path, 'unhandled_node_outcome');
    }

    return this.executeSequenceChild(children, index + 1, context, parentPath);
  }

  private async executeOutcomeSwitch(
    node: Extract<PipelineNode, { readonly kind: 'outcomeSwitch' }>,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<NodeExecutionResult> {
    const source = await this.executeNode(node.source, context, parentPath);
    if (source.kind === 'finished') {
      return source;
    }

    const route = Object.hasOwn(node.cases, source.outcome)
      ? node.cases[source.outcome]
      : node.default;
    return route === undefined
      ? this.invalidNode(runtimePath(context, parentPath), 'unhandled_node_outcome')
      : this.executeNode(route, context, parentPath);
  }

  private async executeConditionalBranch(
    node: Extract<PipelineNode, { readonly kind: 'branch' }>,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const value = new InputResolver(context).resolve(node.value);
    if (!value.resolved) {
      return this.inputResolutionFailed(context, nodePath, value.errorCode);
    }
    if (value.value.kind !== 'json' || typeof value.value.value !== 'string') {
      return this.invalidNode(runtimePath(context, nodePath), 'invalid_branch_value');
    }

    const selected = Object.hasOwn(node.cases, value.value.value)
      ? node.cases[value.value.value]
      : node.default;
    if (selected === undefined) {
      return this.invalidNode(runtimePath(context, nodePath), 'branch_not_found');
    }
    if (!Object.hasOwn(node.cases, value.value.value)) {
      await this.events.write('pipeline.branchDefaulted', {
        path: runtimePath(context, nodePath),
      });
    }

    return this.executeNode(selected, context, nodePath);
  }

  private async executeSubpipeline(
    node: Extract<PipelineNode, { readonly kind: 'subpipeline' }>,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const input = new InputResolver(context).resolveMapping(node.input);
    if (!input.resolved) {
      return this.inputResolutionFailed(context, nodePath, input.errorCode);
    }

    const result = await this.executePipeline({
      ...context,
      scopeId: createSubpipelineScopeId({
        parentScopeId: context.scopeId,
        authoredNodeId: createAuthoredNodeId({
          schemaVersion: context.plan.schemaVersion,
          pipelineId: context.pipelineId,
          nodePath,
          nodeKind: node.kind,
        }),
        invocationOrdinal: 1,
      }),
      pipelineId: node.pipelineId,
      pipelineInput: { kind: 'mapping', values: input.value },
      runtimePath: runtimePath(context, nodePath),
      outputs: new Map(),
    });
    if (result.output !== undefined) {
      context.outputs.set(nodePath, result.output);
    }
    if (result.status === 'failed') {
      await this.events.write('subpipeline.failed', { path: runtimePath(context, nodePath) });
    }

    return continuedExecution(result.outcome, runtimePath(context, nodePath), result.output);
  }

  private async executeEnd(
    node: Extract<PipelineNode, { readonly kind: 'end' }>,
    context: PipelineExecutionContext,
  ): Promise<NodeExecutionResult> {
    const output = new InputResolver(context).resolveTerminalOutput(node.output);
    if (!output.resolved) {
      return this.invalidNode(context.runtimePath, output.errorCode);
    }

    return {
      kind: 'finished',
      result: {
        status: node.status,
        outcome: node.outcome,
        ...(Object.keys(output.value).length === 0 ? {} : { output: output.value }),
      },
    };
  }

  private async inputResolutionFailed(
    context: PipelineExecutionContext,
    nodePath: string,
    errorCode: string,
  ): Promise<NodeExecutionResult> {
    await this.events.write('inputResolution.failed', {
      path: runtimePath(context, nodePath),
      errorCode,
    });
    return continuedExecution('failed', runtimePath(context, nodePath));
  }

  private async invalid(path: string, errorCode: string): Promise<RunWorkflowResult> {
    await this.events.write('pipeline.invalidState', { path, errorCode });
    return { status: 'failed', outcome: 'invalid' };
  }

  private async invalidNode(path: string, errorCode: string): Promise<NodeExecutionResult> {
    return { kind: 'finished', result: await this.invalid(path, errorCode) };
  }
}
