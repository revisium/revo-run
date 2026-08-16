import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { RunConsensus } from '../../contracts/run/run-details.js';
import type { ParticipantSettlement } from '../../contracts/workflow/participant-settlement.js';
import {
  admitParticipantSettlement,
  initialConsensusState,
  remainingParticipantIds,
  type ConsensusReductionState,
} from '../../pipeline/consensus/consensus-policy.js';
import { parseDurableConsensusVerdict } from '../../validation/consensus-verdict.validator.js';
import { parseParticipantSettlement } from '../../validation/participant-settlement.validator.js';
import {
  consensusVerdictNodeInstanceId,
  consensusWaitingNodeInstanceId,
  isConsensusVerdictStepName,
  isConsensusWaitingStepName,
} from '../consensus/consensus-names.js';
import type { DbosStepRecord } from './dbos-step-pages.js';
import type { ObservableConsensusCandidate } from './observable-consensus-participants.js';
import type { ObservablePlan, ObservableScopeCandidate } from './observable-plan.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

interface PendingConsensus {
  readonly candidate: ObservableConsensusCandidate;
  readonly openedAt?: Date;
  state: ConsensusReductionState;
}

export class RunConsensusProjector {
  private readonly pending = new Map<string, PendingConsensus>();
  private readonly resolved = new Map<string, RunConsensus>();

  constructor(private readonly plan: ObservablePlan) {}

  includeScopeSteps(steps: readonly DbosStepRecord[], physicalScope: DurableScopeCandidate): void {
    for (const step of steps) {
      if (isConsensusWaitingStepName(step.name)) {
        this.includeWaiting(step, physicalScope);
      }
      if (isConsensusVerdictStepName(step.name)) {
        this.includeVerdict(step);
      }
    }
  }

  includeScopeStatus(status: WorkflowStatus, candidate: DurableScopeCandidate): void {
    if (candidate.kind !== 'consensusParticipant' || status.status !== 'SUCCESS') {
      return;
    }
    this.includeSettlement(candidate, parseParticipantSettlement(status.output));
  }

  finish(): readonly RunConsensus[] {
    const pending = [...this.pending.values()].map((entry) => this.toPending(entry));
    return [...this.resolved.values(), ...pending].toSorted((left, right) =>
      left.displayPath.localeCompare(right.displayPath),
    );
  }

  private includeWaiting(step: DbosStepRecord, physicalScope: DurableScopeCandidate): void {
    if (step.error !== null) {
      throw new Error('Consensus waiting step failed.');
    }
    const nodeInstanceId = consensusWaitingNodeInstanceId(step.name);
    if (step.output !== nodeInstanceId) {
      throw new Error('Consensus waiting checkpoint identity is invalid.');
    }
    const candidate = this.plan.consensusesByNodeInstanceId.get(nodeInstanceId);
    if (candidate?.physicalScopeId !== physicalScope.id) {
      throw new Error('Consensus waiting checkpoint is not present in its admitted scope.');
    }
    if (this.pending.has(nodeInstanceId) || this.resolved.has(nodeInstanceId)) {
      throw new Error('Consensus waiting checkpoint is duplicated.');
    }
    this.pending.set(nodeInstanceId, {
      candidate,
      ...(step.startedAtEpochMs === undefined ? {} : { openedAt: new Date(step.startedAtEpochMs) }),
      state: initialConsensusState(),
    });
  }

  private includeVerdict(step: DbosStepRecord): void {
    if (step.error !== null) {
      throw new Error('Consensus verdict step failed.');
    }
    const nodeInstanceId = consensusVerdictNodeInstanceId(step.name);
    const pending = this.pending.get(nodeInstanceId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(nodeInstanceId);
    if (
      step.output !== null &&
      typeof step.output === 'object' &&
      'kind' in step.output &&
      (step.output.kind === 'cancel' || step.output.kind === 'fail')
    ) {
      return;
    }
    const verdict = parseDurableConsensusVerdict(step.output);
    this.resolved.set(nodeInstanceId, {
      ...this.base(pending.candidate, pending.openedAt),
      acceptedVotes: verdict.acceptedVotes,
      failedParticipantIds: verdict.failedParticipantIds,
      invalidParticipantIds: verdict.invalidParticipantIds,
      remainingParticipantIds: verdict.remainingParticipantIds,
      status: 'resolved',
      verdict: verdict.verdict,
      ...(step.completedAtEpochMs === undefined
        ? {}
        : { resolvedAt: new Date(step.completedAtEpochMs) }),
    });
  }

  private includeSettlement(
    candidate: Extract<DurableScopeCandidate, { readonly kind: 'consensusParticipant' }>,
    settlement: ParticipantSettlement,
  ): void {
    const pending = this.pending.get(candidate.consensusIdentity.consensusNodeInstanceId);
    if (
      pending === undefined ||
      this.resolved.has(candidate.consensusIdentity.consensusNodeInstanceId)
    ) {
      return;
    }
    const admission = admitParticipantSettlement(
      pending.candidate.participantIds,
      pending.state,
      candidate.consensusIdentity.participantId,
      settlement,
    );
    if (admission.kind === 'unknown' || admission.kind === 'duplicate') {
      return;
    }
    const next = admitIntoState(
      pending.candidate.participantIds,
      pending.state,
      candidate.consensusIdentity.participantId,
      settlement,
    );
    this.pending.set(candidate.consensusIdentity.consensusNodeInstanceId, {
      ...pending,
      state: next,
    });
  }

  private toPending(entry: PendingConsensus): RunConsensus {
    return {
      ...this.base(entry.candidate, entry.openedAt),
      acceptedVotes: entry.state.accepted,
      failedParticipantIds: entry.state.failedIds,
      invalidParticipantIds: entry.state.invalidIds,
      remainingParticipantIds: remainingParticipantIds(entry.candidate.participantIds, entry.state),
      status: 'pending',
    };
  }

  private base(candidate: ObservableConsensusCandidate, openedAt?: Date) {
    return {
      scopeId: candidate.scopeId,
      nodeInstanceId: candidate.nodeInstanceId,
      authoredNodeId: candidate.authoredNodeId,
      pipelineId: candidate.pipelineId,
      nodePath: candidate.nodePath,
      displayPath: candidate.displayPath,
      policy: candidate.node.policy,
      remaining: candidate.node.remaining,
      ...(candidate.node.timeoutMs === undefined ? {} : { timeoutMs: candidate.node.timeoutMs }),
      ...(openedAt === undefined ? {} : {}),
    };
  }
}

const admitIntoState = (
  authoredIds: readonly string[],
  state: ConsensusReductionState,
  participantId: string,
  settlement: ParticipantSettlement,
): ConsensusReductionState => {
  const admission = admitParticipantSettlement(authoredIds, state, participantId, settlement);
  const settledIds = [...state.settledIds, participantId];
  if (admission.kind === 'accepted') {
    return {
      ...state,
      settledIds,
      accepted: [
        ...state.accepted,
        {
          participantId,
          vote: admission.vote.vote,
          executionId: admission.vote.executionId,
        },
      ],
    };
  }
  if (admission.kind === 'failed' || admission.kind === 'timedOut') {
    return { ...state, settledIds, failedIds: [...state.failedIds, participantId] };
  }
  if (admission.kind === 'invalid') {
    return { ...state, settledIds, invalidIds: [...state.invalidIds, participantId] };
  }
  if (admission.kind === 'cancelled') {
    return { ...state, settledIds, cancelledIds: [...state.cancelledIds, participantId] };
  }
  return state;
};
