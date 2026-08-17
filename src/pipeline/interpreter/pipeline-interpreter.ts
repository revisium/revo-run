import { pipelineNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { ParallelBranchResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { MapItemBodyResult, MapItemRunner } from '../map/map-item-runner.js';
import type { ParallelBranchRunner } from '../parallel/parallel-branch-runner.js';
import type {
  RepeatIterationBodyResult,
  RepeatIterationRunner,
} from '../repeat/repeat-iteration-runner.js';
import { withCancellationEvent } from './cancellation-event-policy.js';
import type { ConsensusExecutionPorts } from './consensus-execution-ports.js';
import { ConsensusNodeExecutor } from './consensus-node-executor.js';
import type { WaitForDelay } from './delay-execution-ports.js';
import { DelayNodeExecutor } from './delay-node-executor.js';
import { HumanGateNodeExecutor } from './human-gate-node-executor.js';
import type { WaitForHumanGate } from './human-gate-ports.js';
import type { InlineScopeOwnershipRegistrar } from './inline-scope-ownership-registrar.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import { MapNodeExecutor } from './map-node-executor.js';
import { ParallelNodeExecutor } from './parallel-node-executor.js';
import type { PipelineEventSink } from './pipeline-event-sink.js';
import { PipelineFailureReporter } from './pipeline-failure-reporter.js';
import { PipelineNodeDispatch } from './pipeline-node-dispatch.js';
import type { FinishedNodeExecutionResult, NodeExecutionResult } from './pipeline-node-result.js';
import { RepeatNodeExecutor } from './repeat-node-executor.js';
import {
  toBranchScopeResult,
  toMapItemScopeResult,
  toRepeatScopeResult,
} from './scope-result-mapping.js';
import type { ExecuteNodeEffect, WaitForRetry } from './task-execution-ports.js';
import { TaskNodeExecutor } from './task-node-executor.js';
import type { WaitForUnknownOutcome } from './unknown-outcome-ports.js';

export interface PipelineInterpreterDependencies {
  readonly executeEffect: ExecuteNodeEffect;
  readonly waitForRetry: WaitForRetry;
  readonly parallel: ParallelBranchRunner;
  readonly repeatIterations: RepeatIterationRunner;
  readonly mapItems: MapItemRunner;
  readonly inlineScopes: InlineScopeOwnershipRegistrar;
  readonly events: PipelineEventSink;
  readonly waitForDelay: WaitForDelay;
  readonly waitForUnknownOutcome: WaitForUnknownOutcome;
  readonly waitForHumanGate: WaitForHumanGate;
  readonly consensus: ConsensusExecutionPorts;
}

export class PipelineInterpreter {
  private readonly failures: PipelineFailureReporter;
  private readonly dispatch: PipelineNodeDispatch;

  constructor({
    executeEffect,
    waitForRetry,
    parallel,
    repeatIterations,
    mapItems,
    inlineScopes,
    events,
    waitForDelay,
    waitForUnknownOutcome,
    waitForHumanGate,
    consensus,
  }: PipelineInterpreterDependencies) {
    this.failures = new PipelineFailureReporter(events);
    this.dispatch = new PipelineNodeDispatch({
      tasks: new TaskNodeExecutor(
        withCancellationEvent(executeEffect, events),
        waitForRetry,
        events,
        waitForUnknownOutcome,
      ),
      delays: new DelayNodeExecutor(waitForDelay, events),
      humanGates: new HumanGateNodeExecutor(waitForHumanGate),
      maps: new MapNodeExecutor(mapItems, events),
      repeats: new RepeatNodeExecutor(repeatIterations, events),
      parallel: new ParallelNodeExecutor(parallel, events),
      consensus: new ConsensusNodeExecutor(consensus),
      failures: this.failures,
      events,
      inlineScopes,
      executePipeline: (next) => this.executePipeline(next),
    });
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
    return toBranchScopeResult(
      await this.executeNode(node, context, parentPath),
      context,
      branchKey,
      inheritedOutputPaths,
    );
  }

  async executeRepeatIterationScope(
    node: Extract<PipelineNode, { readonly kind: 'parallel' | 'repeat' | 'subpipeline' | 'task' }>,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<RepeatIterationBodyResult> {
    return toRepeatScopeResult(await this.executeNode(node, context, parentPath));
  }

  async executeMapItemScope(
    node: PipelineNode,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<MapItemBodyResult> {
    return toMapItemScopeResult(await this.executeNode(node, context, parentPath));
  }

  executeConsensusParticipantScope(
    node: Extract<PipelineNode, { readonly kind: 'task' }>,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<NodeExecutionResult> {
    return this.executeNode(node, context, parentPath);
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
    return this.dispatch.executeNode(node, context, parentPath);
  }
}
