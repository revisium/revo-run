import type { ConsensusNode, ConsensusPolicy } from '../../contracts/pipeline/pipeline-node.js';
import type { ConsensusResolutionDirective } from '../../contracts/workflow/consensus-resolution.js';
import type { PipelineExecutionContext } from '../interpreter/interpreter-context.js';

export interface ConsensusParticipantInstance {
  readonly participantId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly nodeInstanceId: string;
  readonly workflowId: string;
}

export interface ConsensusWaitRequest {
  readonly consensusNodeInstanceId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly participantIds: readonly string[];
  readonly participantInstances: readonly ConsensusParticipantInstance[];
  readonly policy: ConsensusPolicy;
  readonly remaining: 'cancel' | 'drain';
  readonly timeoutMs?: number;
}

export type WaitForConsensusResolution = (
  request: ConsensusWaitRequest,
) => Promise<ConsensusResolutionDirective>;

export interface ConsensusParticipantRunner {
  execute(
    node: ConsensusNode,
    context: PipelineExecutionContext,
    nodePath: string,
    wait: WaitForConsensusResolution,
  ): Promise<ConsensusResolutionDirective>;
}
