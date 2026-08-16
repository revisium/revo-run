import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type { ConsensusResolutionDirective } from '../../contracts/workflow/consensus-resolution.js';
import type { DurableConsensusVerdict } from '../../contracts/workflow/consensus-verdict.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import {
  admitParticipantSettlement,
  remainingParticipantIds,
  reduceConsensusDeadline,
  reduceConsensusSettlement,
} from '../../pipeline/consensus/consensus-policy.js';
import { consensusResolutionTopic } from '../consensus/consensus-names.js';
import {
  ConsensusRegistry,
  consensusEntryFromWaiting,
  type WaitingConsensus,
} from './consensus-registry.js';

export const waitingConsensusFenceDirective = (
  eventBudgetExceeded: boolean,
  cancellationRequested: boolean,
  subtreeFenced: boolean,
): 'cancel' | 'fail' | undefined => {
  if (eventBudgetExceeded) {
    return 'fail';
  }
  return cancellationRequested || subtreeFenced ? 'cancel' : undefined;
};

export class ConsensusCoordination {
  private readonly registry = new ConsensusRegistry();

  async register(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'consensusWaiting' }>,
    fenceDirective: 'cancel' | 'fail' | undefined,
  ): Promise<void> {
    const entry = consensusEntryFromWaiting(message);
    if (fenceDirective === undefined) {
      this.registry.register(message.consensusNodeInstanceId, entry);
      return;
    }
    this.registry.registerResolved(message.consensusNodeInstanceId, entry);
    await DBOS.send(
      message.workflowId,
      { kind: fenceDirective },
      consensusResolutionTopic(message.consensusNodeInstanceId),
    );
  }

  async admitSettlement(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'consensusParticipantSettled' }>,
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    const entry = this.registry.get(message.consensusNodeInstanceId);
    if (entry === undefined || entry.workflowId !== message.workflowId) {
      return;
    }
    const admission = admitParticipantSettlement(
      entry.participantIds,
      entry.state,
      message.participantId,
      message.settlement,
    );
    if (admission.kind === 'unknown') {
      await appendEvent({
        type: 'consensus.unknownParticipantRejected',
        data: {
          ...consensusIdentity(message.consensusNodeInstanceId, entry),
          participantId: message.participantId,
        },
      });
      return;
    }
    if (admission.kind === 'duplicate') {
      await appendEvent({
        type: 'consensus.duplicateParticipantResultRejected',
        data: participantIdentity(entry, message.participantId),
      });
      return;
    }
    if (entry.resolved) {
      return;
    }
    const reduction = reduceConsensusSettlement(
      entry.policy,
      entry.participantIds,
      entry.state,
      message.participantId,
      message.settlement,
    );
    this.registry.replaceState(message.consensusNodeInstanceId, reduction.state);
    if (reduction.kind !== 'decided') {
      return;
    }
    await this.decide(
      message.consensusNodeInstanceId,
      entry,
      reduction.verdict,
      appendEvent,
      message.participantId,
    );
  }

  async resolveDeadline(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'consensusDeadlineReached' }>,
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    const entry = this.registry.get(message.consensusNodeInstanceId);
    if (entry === undefined || entry.resolved || entry.workflowId !== message.workflowId) {
      return;
    }
    const reduction = reduceConsensusDeadline(entry.policy, entry.participantIds, entry.state);
    this.registry.replaceState(message.consensusNodeInstanceId, reduction.state);
    if (reduction.kind !== 'decided') {
      return;
    }
    await this.decide(message.consensusNodeInstanceId, entry, reduction.verdict, appendEvent);
  }

  sendAll(
    directive: 'cancel' | 'fail',
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    return this.fanOut(this.registry.unresolved(), directive, appendEvent);
  }

  sendForWorkflows(
    workflowIds: readonly string[],
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    return this.fanOut(
      this.registry.entriesForWorkflows(new Set(workflowIds)),
      'cancel',
      appendEvent,
    );
  }

  private async decide(
    nodeInstanceId: string,
    entry: WaitingConsensus,
    verdictName: DurableConsensusVerdict['verdict'],
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
    failedParticipantId?: string,
  ): Promise<void> {
    const verdict: DurableConsensusVerdict = {
      kind: 'consensusVerdict',
      scopeId: entry.scopeId,
      nodeInstanceId,
      verdict: verdictName,
      remaining: entry.remaining,
      acceptedVotes: [...entry.state.accepted],
      failedParticipantIds: [...entry.state.failedIds],
      invalidParticipantIds: [...entry.state.invalidIds],
      remainingParticipantIds: remainingParticipantIds(entry.participantIds, entry.state),
    };
    this.registry.markResolved(nodeInstanceId, verdict);
    await DBOS.send(
      entry.workflowId,
      { kind: 'decided', verdict } satisfies ConsensusResolutionDirective,
      consensusResolutionTopic(nodeInstanceId),
    );
    const event = verdictEvent(verdictName, nodeInstanceId, entry, failedParticipantId);
    if (event !== undefined) {
      await appendEvent(event);
    }
  }

  private async fanOut(
    targets: ReadonlyArray<readonly [string, WaitingConsensus]>,
    directive: 'cancel' | 'fail',
    _appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    for (const [nodeInstanceId] of targets) {
      this.registry.markResolved(nodeInstanceId);
    }
    await targets.reduce<Promise<void>>(async (previous, [nodeInstanceId, entry]) => {
      await previous;
      await DBOS.send(
        entry.workflowId,
        { kind: directive },
        consensusResolutionTopic(nodeInstanceId),
      );
    }, Promise.resolve());
  }
}

const consensusIdentity = (
  nodeInstanceId: string,
  entry: WaitingConsensus,
): { scopeId: string; authoredNodeId: string; nodeInstanceId: string } => ({
  scopeId: entry.scopeId,
  authoredNodeId: entry.authoredNodeId,
  nodeInstanceId,
});

const participantIdentity = (
  entry: WaitingConsensus,
  participantId: string,
): { scopeId: string; authoredNodeId: string; nodeInstanceId: string } => {
  const instance = entry.participantInstances.get(participantId);
  if (instance === undefined) {
    return consensusIdentity('', entry);
  }
  return {
    scopeId: instance.scopeId,
    authoredNodeId: instance.authoredNodeId,
    nodeInstanceId: instance.nodeInstanceId,
  };
};

const verdictEvent = (
  verdict: DurableConsensusVerdict['verdict'],
  nodeInstanceId: string,
  entry: WaitingConsensus,
  failedParticipantId?: string,
): RunEventDraft | undefined => {
  if (verdict === 'rejected') {
    return { type: 'consensus.rejected', data: consensusIdentity(nodeInstanceId, entry) };
  }
  if (verdict === 'insufficientQuorum') {
    return { type: 'consensus.insufficientQuorum', data: consensusIdentity(nodeInstanceId, entry) };
  }
  if (verdict === 'timedOut') {
    return { type: 'consensus.timedOut', data: consensusIdentity(nodeInstanceId, entry) };
  }
  if (verdict === 'failed' && failedParticipantId !== undefined) {
    return {
      type: 'consensus.participantFailed',
      data: participantIdentity(entry, failedParticipantId),
    };
  }
  return undefined;
};
