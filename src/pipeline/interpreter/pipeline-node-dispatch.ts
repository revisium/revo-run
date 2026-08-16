import { pipelineNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import { InputResolver } from '../data/input-resolver.js';
import { createAuthoredNodeId, createSubpipelineScopeId } from '../identity/execution-identity.js';
import type { ParallelBranchRunner } from '../parallel/parallel-branch-runner.js';
import type { ConsensusNodeExecutor } from './consensus-node-executor.js';
import type { DelayNodeExecutor } from './delay-node-executor.js';
import type { HumanGateNodeExecutor } from './human-gate-node-executor.js';
import type { InlineScopeOwnershipRegistrar } from './inline-scope-ownership-registrar.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import type { MapNodeExecutor } from './map-node-executor.js';
import { runtimePath } from './node-path.js';
import { pipelineNodeEventIdentity, type PipelineEventSink } from './pipeline-event-sink.js';
import type { PipelineFailureReporter } from './pipeline-failure-reporter.js';
import type { FinishedNodeExecutionResult, NodeExecutionResult } from './pipeline-node-result.js';
import {
  authoredEndExecution,
  continuedExecution,
  terminalExecution,
} from './pipeline-node-result.js';
import type { RepeatNodeExecutor } from './repeat-node-executor.js';
import type { TaskNodeExecutor } from './task-node-executor.js';

export interface PipelineNodeDispatchPorts {
  readonly tasks: TaskNodeExecutor;
  readonly delays: DelayNodeExecutor;
  readonly humanGates: HumanGateNodeExecutor;
  readonly maps: MapNodeExecutor;
  readonly repeats: RepeatNodeExecutor;
  readonly parallel: ParallelBranchRunner;
  readonly consensus: ConsensusNodeExecutor;
  readonly failures: PipelineFailureReporter;
  readonly events: PipelineEventSink;
  readonly inlineScopes: InlineScopeOwnershipRegistrar;
  readonly executePipeline: (
    context: PipelineExecutionContext,
  ) => Promise<FinishedNodeExecutionResult>;
}

export class PipelineNodeDispatch {
  constructor(private readonly ports: PipelineNodeDispatchPorts) {}

  executeNode(
    node: PipelineNode,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<NodeExecutionResult> {
    const nodePath = pipelineNodePath(node, parentPath);
    switch (node.kind) {
      case 'task':
        return this.ports.tasks.execute(node, context, nodePath);
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
        return this.ports.delays.execute(node, context, nodePath);
      case 'humanGate':
        return this.ports.humanGates.execute(node, context, nodePath);
      case 'repeat':
        return this.ports.repeats.execute(node, context, nodePath);
      case 'map':
        return this.ports.maps.execute(node, context, nodePath);
      case 'end':
        return this.executeEnd(node, context, nodePath);
      case 'consensus':
        return this.ports.consensus.execute(node, context, nodePath);
    }
    node satisfies never;
    return node;
  }

  executeSequence(
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
      return this.ports.failures.invalidNode(
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
      ? this.ports.failures.invalidNode(
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
      return this.ports.failures.inputResolutionFailed(node, context, nodePath, value.errorCode);
    }
    if (value.value.kind !== 'json' || typeof value.value.value !== 'string') {
      return this.ports.failures.invalidNode(node, context, nodePath, 'invalid_branch_value');
    }
    const selected = Object.hasOwn(node.cases, value.value.value)
      ? node.cases[value.value.value]
      : node.default;
    if (selected === undefined) {
      return this.ports.failures.invalidNode(node, context, nodePath, 'branch_not_found');
    }
    if (!Object.hasOwn(node.cases, value.value.value)) {
      await this.ports.events.write({
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
      return this.ports.failures.inputResolutionFailed(node, context, nodePath, input.errorCode);
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
    await this.ports.inlineScopes.registerInlineScopeOwnership({
      parentScopeId: context.scopeId,
      scopeId,
      authoredNodeId,
      invocationOrdinal,
    });
    const result = await this.ports.executePipeline({
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
      await this.ports.events.write({
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
    const result = await this.ports.parallel.execute(node, context, nodePath);
    if (result.kind === 'terminal') {
      return terminalExecution(result.result);
    }
    for (const branch of result.eligibleResults) {
      for (const [path, output] of branch.outputs) {
        context.outputs.set(path, output);
      }
    }
    if (result.outcome === 'failed') {
      await this.ports.events.write({
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
      return this.ports.failures.invalidNode(node, context, nodePath, output.errorCode);
    }
    return authoredEndExecution({
      status: node.status,
      outcome: node.outcome,
      ...(Object.keys(output.value).length === 0 ? {} : { output: output.value }),
    });
  }
}
