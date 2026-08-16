import { pipelineNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { ParallelBranchResult } from '../../contracts/workflow/parallel-branch-result.js';
import { InputResolver } from '../data/input-resolver.js';
import { createAuthoredNodeId, createSubpipelineScopeId } from '../identity/execution-identity.js';
import type { MapItemBodyResult, MapItemRunner } from '../map/map-item-runner.js';
import type { ParallelBranchRunner } from '../parallel/parallel-branch-runner.js';
import type {
  RepeatIterationBodyResult,
  RepeatIterationRunner,
} from '../repeat/repeat-iteration-runner.js';
import { withCancellationEvent } from './cancellation-event-policy.js';
import { DelayNodeExecutor } from './delay-node-executor.js';
import { HumanGateNodeExecutor } from './human-gate-node-executor.js';
import type { InlineScopeOwnershipRegistrar } from './inline-scope-ownership-registrar.js';
import type {
  ExecuteNodeEffect,
  PipelineExecutionContext,
  WaitForDelay,
  WaitForHumanGate,
  WaitForRetry,
  WaitForUnknownOutcome,
} from './interpreter-context.js';
import { MapNodeExecutor } from './map-node-executor.js';
import { runtimePath } from './node-path.js';
import { pipelineNodeEventIdentity, type PipelineEventSink } from './pipeline-event-sink.js';
import { PipelineFailureReporter } from './pipeline-failure-reporter.js';
import type { FinishedNodeExecutionResult, NodeExecutionResult } from './pipeline-node-result.js';
import {
  authoredEndExecution,
  continuedExecution,
  terminalExecution,
} from './pipeline-node-result.js';
import { RepeatNodeExecutor } from './repeat-node-executor.js';
import { TaskNodeExecutor } from './task-node-executor.js';

export class PipelineInterpreter {
  private readonly failures: PipelineFailureReporter;
  private readonly delays: DelayNodeExecutor;
  private readonly humanGates: HumanGateNodeExecutor;
  private readonly maps: MapNodeExecutor;
  private readonly repeats: RepeatNodeExecutor;
  private readonly tasks: TaskNodeExecutor;

  constructor(
    executeEffect: ExecuteNodeEffect,
    waitForRetry: WaitForRetry,
    private readonly parallel: ParallelBranchRunner,
    repeatIterations: RepeatIterationRunner,
    mapItems: MapItemRunner,
    private readonly inlineScopes: InlineScopeOwnershipRegistrar,
    private readonly events: PipelineEventSink,
    waitForDelay: WaitForDelay,
    waitForUnknownOutcome: WaitForUnknownOutcome,
    waitForHumanGate: WaitForHumanGate,
  ) {
    this.failures = new PipelineFailureReporter(events);
    this.delays = new DelayNodeExecutor(waitForDelay, events);
    this.humanGates = new HumanGateNodeExecutor(waitForHumanGate);
    this.maps = new MapNodeExecutor(mapItems, events);
    this.repeats = new RepeatNodeExecutor(repeatIterations, events);
    this.tasks = new TaskNodeExecutor(
      withCancellationEvent(executeEffect, events),
      waitForRetry,
      events,
      waitForUnknownOutcome,
    );
  }

  execute(
    plan: ExecutionPlan,
    runId: string,
    runInput: PipelineExecutionContext['runInput'],
    scopeId: string,
  ): Promise<FinishedNodeExecutionResult> {
    return this.executePipeline({
      plan,
      runId,
      scopeId,
      runInput,
      pipelineId: plan.rootPipelineId,
      pipelineInput: { kind: 'value', value: { kind: 'json', value: runInput } },
      runtimePath: plan.rootPipelineId,
      outputs: new Map(),
      maximumParallelism: plan.policies.maximumActiveNodeExecutions,
      nodePathPrefix: '',
    });
  }

  async executeBranchScope(
    node: PipelineNode,
    context: PipelineExecutionContext,
    parentPath: string,
    branchKey: string,
    inheritedOutputPaths: ReadonlySet<string>,
  ): Promise<ParallelBranchResult> {
    const result = await this.executeNode(node, context, parentPath);
    if (result.kind === 'continued' || result.provenance === 'authoredEnd') {
      return {
        kind: 'continued',
        key: branchKey,
        outcome: result.kind === 'continued' ? result.outcome : result.result.outcome,
        outputs: [...context.outputs].filter(([path]) => !inheritedOutputPaths.has(path)),
      };
    }
    return { kind: 'terminal', key: branchKey, result: result.result };
  }

  async executeRepeatIterationScope(
    node: Extract<PipelineNode, { readonly kind: 'parallel' | 'repeat' | 'subpipeline' | 'task' }>,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<RepeatIterationBodyResult> {
    const result = await this.executeNode(node, context, parentPath);
    if (result.kind === 'continued') {
      return {
        kind: 'continued',
        outcome: result.outcome,
        ...(result.output === undefined ? {} : { output: result.output }),
      };
    }
    if (result.provenance === 'authoredEnd') {
      throw new Error('Repeat iteration body produced an authored terminal End.');
    }
    return { kind: 'terminal', result: result.result };
  }

  async executeMapItemScope(
    node: PipelineNode,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<MapItemBodyResult> {
    const result = await this.executeNode(node, context, parentPath);
    if (result.kind === 'continued') {
      return {
        kind: 'continued',
        outcome: result.outcome,
        ...(result.output === undefined ? {} : { output: result.output }),
      };
    }
    return result.provenance === 'authoredEnd'
      ? { kind: 'authoredEnd', result: result.result }
      : { kind: 'terminal', result: result.result };
  }

  private async executePipeline(
    context: PipelineExecutionContext,
  ): Promise<FinishedNodeExecutionResult> {
    const pipeline = Object.hasOwn(context.plan.pipelines, context.pipelineId)
      ? context.plan.pipelines[context.pipelineId]
      : undefined;
    if (pipeline === undefined) {
      throw new Error(`Validated pipeline ${context.pipelineId} was not found.`);
    }
    const result = await this.executeNode(pipeline.root, context, '');
    if (result.kind === 'finished') {
      return result;
    }
    return await this.failures.invalidNode(
      pipeline.root,
      context,
      pipelineNodePath(pipeline.root, ''),
      'terminal_not_reached',
    );
  }

  private executeNode(
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
        return this.executeParallel(node, context, nodePath);
      case 'delay':
        return this.delays.execute(node, context, nodePath);
      case 'humanGate':
        return this.humanGates.execute(node, context, nodePath);
      case 'repeat':
        return this.repeats.execute(node, context, nodePath);
      case 'map':
        return this.maps.execute(node, context, nodePath);
      case 'end':
        return this.executeEnd(node, context, nodePath);
      case 'consensus':
        return this.failures.invalidNode(node, context, nodePath, 'node_kind_not_implemented');
    }
    node satisfies never;
    return node;
  }

  private executeSequence(
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
      return this.failures.invalidNode(
        child,
        context,
        pipelineNodePath(child, parentPath),
        'unhandled_node_outcome',
      );
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
      ? this.failures.invalidNode(
          node,
          context,
          pipelineNodePath(node, parentPath),
          'unhandled_node_outcome',
        )
      : this.executeNode(route, context, parentPath);
  }

  private async executeConditionalBranch(
    node: Extract<PipelineNode, { readonly kind: 'branch' }>,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const value = new InputResolver(context).resolve(node.value);
    if (!value.resolved) {
      return this.failures.inputResolutionFailed(node, context, nodePath, value.errorCode);
    }
    if (value.value.kind !== 'json' || typeof value.value.value !== 'string') {
      return this.failures.invalidNode(node, context, nodePath, 'invalid_branch_value');
    }
    const selected = Object.hasOwn(node.cases, value.value.value)
      ? node.cases[value.value.value]
      : node.default;
    if (selected === undefined) {
      return this.failures.invalidNode(node, context, nodePath, 'branch_not_found');
    }
    if (!Object.hasOwn(node.cases, value.value.value)) {
      await this.events.write({
        type: 'pipeline.branchDefaulted',
        data: pipelineNodeEventIdentity(node, context, nodePath),
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
      return this.failures.inputResolutionFailed(node, context, nodePath, input.errorCode);
    }
    const invocationOrdinal = 1;
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: node.kind,
    });
    const scopeId = createSubpipelineScopeId({
      parentScopeId: context.scopeId,
      authoredNodeId,
      invocationOrdinal,
    });
    await this.inlineScopes.registerInlineScopeOwnership({
      parentScopeId: context.scopeId,
      scopeId,
      authoredNodeId,
      invocationOrdinal,
    });
    const result = await this.executePipeline({
      ...context,
      scopeId,
      pipelineId: node.pipelineId,
      pipelineInput: { kind: 'mapping', values: input.value },
      runtimePath: runtimePath(context, nodePath),
      outputs: new Map(),
      nodePathPrefix: '',
    });
    if (result.provenance === 'terminal') {
      return result;
    }
    const settlement = result.result;
    if (settlement.output !== undefined) {
      context.outputs.set(nodePath, settlement.output);
    }
    if (settlement.status === 'failed') {
      await this.events.write({
        type: 'subpipeline.failed',
        data: pipelineNodeEventIdentity(node, context, nodePath),
      });
    }
    return continuedExecution(
      settlement.outcome,
      runtimePath(context, nodePath),
      settlement.output,
    );
  }

  private async executeParallel(
    node: Extract<PipelineNode, { readonly kind: 'parallel' }>,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const result = await this.parallel.execute(node, context, nodePath);
    if (result.kind === 'terminal') {
      return terminalExecution(result.result);
    }
    for (const branch of result.eligibleResults) {
      for (const [path, output] of branch.outputs) {
        context.outputs.set(path, output);
      }
    }
    if (result.outcome === 'failed') {
      await this.events.write({
        type: 'parallel.joinFailed',
        data: pipelineNodeEventIdentity(node, context, nodePath),
      });
    }
    return continuedExecution(result.outcome, runtimePath(context, nodePath));
  }

  private async executeEnd(
    node: Extract<PipelineNode, { readonly kind: 'end' }>,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const output = new InputResolver(context).resolveTerminalOutput(node.output);
    if (!output.resolved) {
      return this.failures.invalidNode(node, context, nodePath, output.errorCode);
    }
    return authoredEndExecution({
      status: node.status,
      outcome: node.outcome,
      ...(Object.keys(output.value).length === 0 ? {} : { output: output.value }),
    });
  }
}
