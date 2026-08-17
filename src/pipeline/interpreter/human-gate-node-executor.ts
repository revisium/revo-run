import type { HumanGateNode } from '../../contracts/pipeline/pipeline-node.js';
import { createAuthoredNodeId, createNodeInstanceId } from '../identity/execution-identity.js';
import type { HumanGateWaitRequest, WaitForHumanGate } from './human-gate-ports.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

/**
 * The gate never decides; it only proposes its policy to the coordinator and consumes the
 * resolution. The three humanGate.* events belong to the coordinator alone - PipelineEventSink
 * cannot carry them (they are absent from PipelineEventDraftSchema) - so this executor maps a
 * resolution onto the interpreter's result vocabulary and emits nothing itself.
 */
export class HumanGateNodeExecutor {
  constructor(private readonly wait: WaitForHumanGate) {}

  async execute(
    node: HumanGateNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: node.kind,
    });
    const request: HumanGateWaitRequest = {
      gateInstanceId: createNodeInstanceId({ scopeId: context.scopeId, authoredNodeId }),
      scopeId: context.scopeId,
      authoredNodeId,
      answers: node.answers,
      decision: node.decision,
      ...(node.eligibleGroup === undefined ? {} : { eligibleGroup: node.eligibleGroup }),
      ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
    };
    const resolution = await this.wait(request);
    switch (resolution.kind) {
      case 'answered':
        return continuedExecution(resolution.answer, runtimePath(context, nodePath));
      case 'conflict':
        return continuedExecution('conflict', runtimePath(context, nodePath));
      case 'timedOut':
        return continuedExecution('timedOut', runtimePath(context, nodePath));
      case 'cancel':
        return terminalExecution({ status: 'cancelled', outcome: 'cancelled' });
      case 'fail':
        return terminalExecution({ status: 'failed', outcome: 'event_budget_exceeded' });
    }
    resolution satisfies never;
    throw new Error('Human gate resolution is unsupported.');
  }
}
