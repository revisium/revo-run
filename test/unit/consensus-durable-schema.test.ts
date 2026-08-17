import { describe, expect, it } from 'vitest';

import { ConsensusVoteSchema } from '../../src/contracts/pipeline/consensus-vote.js';
import { parseConsensusParticipantWorkflowInput } from '../../src/validation/consensus-participant-workflow-input.validator.js';
import { parseConsensusResolutionDirective } from '../../src/validation/consensus-resolution.validator.js';
import { parseDurableConsensusVerdict } from '../../src/validation/consensus-verdict.validator.js';
import {
  asConsensusVote,
  parseConsensusVote,
} from '../../src/validation/consensus-vote.validator.js';
import { parseParticipantSettlement } from '../../src/validation/participant-settlement.validator.js';
import { parseRunCoordinatorMessage } from '../../src/validation/run-coordinator-message.validator.js';

const digest = 'a'.repeat(43);
const scopeId = `sc1_${digest}`;
const authoredNodeId = `an1_${digest}`;
const nodeInstanceId = `ni1_${digest}`;
const scopeWorkflowId = `rr:scope:${scopeId}`;

const vote = {
  nodePath: 'main/review',
  participantId: 'architecture',
  vote: 'approve' as const,
  executionId: 'execution-architecture-1',
};

describe('consensus durable schemas', () => {
  it('accepts a closed ConsensusVote payload and rejects extras or bad identifiers', () => {
    expect(parseConsensusVote(vote)).toEqual(vote);
    expect(asConsensusVote({ ...vote, extra: true })).toBeUndefined();
    expect(() => parseConsensusVote({ ...vote, participantId: '1bad' })).toThrow(
      'Consensus vote is invalid.',
    );
    expect(ConsensusVoteSchema).toBeDefined();
  });

  it('accepts each ParticipantSettlement variant and rejects nested extras', () => {
    expect(parseParticipantSettlement({ kind: 'voted', vote })).toEqual({ kind: 'voted', vote });
    expect(
      parseParticipantSettlement({ kind: 'completedWithoutVote', outcome: 'completed' }),
    ).toEqual({ kind: 'completedWithoutVote', outcome: 'completed' });
    expect(parseParticipantSettlement({ kind: 'executionFailed' })).toEqual({
      kind: 'executionFailed',
    });
    expect(() => parseParticipantSettlement({ kind: 'voted', vote, extra: true })).toThrow(
      'Participant settlement is invalid.',
    );
  });

  it('accepts a DurableConsensusVerdict and rejects additional properties', () => {
    const verdict = {
      kind: 'consensusVerdict',
      scopeId,
      nodeInstanceId,
      verdict: 'approved',
      remaining: 'drain',
      acceptedVotes: [{ participantId: 'architecture', vote: 'approve', executionId: 'ex-1' }],
      failedParticipantIds: [],
      invalidParticipantIds: [],
      remainingParticipantIds: ['security'],
    };

    expect(parseDurableConsensusVerdict(verdict)).toEqual(verdict);
    expect(() => parseDurableConsensusVerdict({ ...verdict, extra: true })).toThrow(
      'Durable consensus verdict is invalid.',
    );
  });

  it('accepts consensus coordinator messages and rejects malformed settlements', () => {
    expect(
      parseRunCoordinatorMessage({
        kind: 'consensusDeadlineReached',
        workflowId: scopeWorkflowId,
        consensusNodeInstanceId: nodeInstanceId,
      }),
    ).toMatchObject({ kind: 'consensusDeadlineReached' });
    expect(
      parseRunCoordinatorMessage({
        kind: 'consensusParticipantSettled',
        workflowId: scopeWorkflowId,
        consensusNodeInstanceId: nodeInstanceId,
        participantId: 'architecture',
        settlement: { kind: 'voted', vote },
      }),
    ).toMatchObject({ kind: 'consensusParticipantSettled', participantId: 'architecture' });
    expect(() =>
      parseRunCoordinatorMessage({
        kind: 'consensusParticipantSettled',
        workflowId: scopeWorkflowId,
        consensusNodeInstanceId: nodeInstanceId,
        participantId: 'architecture',
        settlement: { kind: 'voted', vote, extra: true },
      }),
    ).toThrow('Run coordinator message is invalid.');
  });

  it('accepts consensus waiting registration and participant workflow input', () => {
    expect(
      parseRunCoordinatorMessage({
        kind: 'consensusWaiting',
        workflowId: scopeWorkflowId,
        consensusNodeInstanceId: nodeInstanceId,
        scopeId,
        authoredNodeId,
        pipelineId: 'main',
        nodePath: 'review',
        participantIds: ['architecture', 'security'],
        participantInstances: [
          {
            participantId: 'architecture',
            scopeId,
            authoredNodeId,
            nodeInstanceId,
          },
        ],
        policy: { kind: 'unanimous' },
        remaining: 'cancel',
      }),
    ).toMatchObject({ kind: 'consensusWaiting', remaining: 'cancel' });
    expect(
      parseConsensusParticipantWorkflowInput({
        runId: 'run_01',
        scopeId,
        parentScopeId: scopeId,
        participantId: 'architecture',
        consensusNodeInstanceId: nodeInstanceId,
        node: { kind: 'task', key: 'architecture' },
        pipelineId: 'main',
        pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
        runtimePath: 'main',
        parentPath: 'review',
        inheritedOutputs: [],
        maximumParallelism: 2,
        parentWorkflowId: scopeWorkflowId,
        startFence: {
          directive: 'start',
          requestId: 'request:1',
          admissionId: 'admission:1',
          workflowId: `rr:scope:sc1_${'b'.repeat(43)}`,
        },
      }).participantId,
    ).toBe('architecture');
    expect(() =>
      parseConsensusParticipantWorkflowInput({
        runId: 'run_01',
        scopeId,
        parentScopeId: scopeId,
        participantId: 'architecture',
        consensusNodeInstanceId: nodeInstanceId,
        node: { kind: 'end', status: 'succeeded', outcome: 'completed' },
        pipelineId: 'main',
        pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
        runtimePath: 'main',
        parentPath: 'review',
        inheritedOutputs: [],
        maximumParallelism: 2,
        parentWorkflowId: scopeWorkflowId,
        startFence: {
          directive: 'start',
          requestId: 'request:1',
          admissionId: 'admission:1',
          workflowId: `rr:scope:sc1_${'b'.repeat(43)}`,
        },
      }),
    ).toThrow('Consensus participant workflow input is invalid.');
  });

  it('accepts resolution directives and rejects unknown kinds', () => {
    expect(parseConsensusResolutionDirective({ kind: 'cancel' })).toEqual({ kind: 'cancel' });
    expect(parseConsensusResolutionDirective({ kind: 'fail' })).toEqual({ kind: 'fail' });
    expect(() => parseConsensusResolutionDirective({ kind: 'tie' })).toThrow(
      'Consensus resolution directive is invalid.',
    );
  });
});
