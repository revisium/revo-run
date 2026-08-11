import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { PipelineEventDraft } from '../../contracts/run/run-event.js';
import { createAuthoredNodeId, createNodeInstanceId } from '../identity/execution-identity.js';
import type { PipelineExecutionContext } from './interpreter-context.js';

export type { PipelineEventDraft } from '../../contracts/run/run-event.js';

export interface PipelineEventSink {
  write(event: PipelineEventDraft): Promise<void>;
}

export const pipelineNodeEventIdentity = (
  node: PipelineNode,
  context: PipelineExecutionContext,
  nodePath: string,
): {
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly nodeInstanceId: string;
} => {
  const authoredNodeId = createAuthoredNodeId({
    schemaVersion: context.plan.schemaVersion,
    pipelineId: context.pipelineId,
    nodePath,
    nodeKind: node.kind,
  });
  return {
    scopeId: context.scopeId,
    authoredNodeId,
    nodeInstanceId: createNodeInstanceId({ scopeId: context.scopeId, authoredNodeId }),
  };
};

export const inputResolutionFailedEvent = (
  node: PipelineNode,
  context: PipelineExecutionContext,
  nodePath: string,
  errorCode: string,
): PipelineEventDraft => ({
  type: 'inputResolution.failed',
  data: { ...pipelineNodeEventIdentity(node, context, nodePath), errorCode },
});

export const pipelineInvalidStateEvent = (
  node: PipelineNode,
  context: PipelineExecutionContext,
  nodePath: string,
  errorCode: string,
): PipelineEventDraft => ({
  type: 'pipeline.invalidState',
  data: { ...pipelineNodeEventIdentity(node, context, nodePath), errorCode },
});
