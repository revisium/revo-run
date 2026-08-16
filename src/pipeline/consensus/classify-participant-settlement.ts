import type { ConsensusVote } from '../../contracts/pipeline/consensus-vote.js';
import type { ParticipantSettlement } from '../../contracts/workflow/participant-settlement.js';
import type { NodeExecutionResult } from '../interpreter/pipeline-node-result.js';
import { classifyCompletedVote } from './consensus-policy.js';

export type ParticipantEffectProvenance = 'completed' | 'failed' | 'timedOut' | 'cancelled';

export const classifyNodeExecutionSettlement = (
  participantId: string,
  result: NodeExecutionResult,
  vote: ConsensusVote | undefined,
  provenance?: ParticipantEffectProvenance,
): ParticipantSettlement => {
  if (provenance === 'cancelled' || (result.kind === 'finished' && result.result.status === 'cancelled')) {
    return { kind: 'cancelled' };
  }
  if (provenance === 'timedOut' || (result.kind === 'continued' && result.outcome === 'timedOut')) {
    return { kind: 'timedOut' };
  }
  if (provenance === 'failed') {
    return { kind: 'executionFailed' };
  }
  if (result.kind === 'finished') {
    return { kind: 'executionFailed' };
  }
  return classifyCompletedVote(participantId, result.outcome, vote);
};
