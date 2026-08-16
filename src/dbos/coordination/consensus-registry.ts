import type { ConsensusPolicy } from '../../contracts/pipeline/pipeline-node.js';
import type { DurableConsensusVerdict } from '../../contracts/workflow/consensus-verdict.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import {
  initialConsensusState,
  type ConsensusReductionState,
} from '../../pipeline/consensus/consensus-policy.js';

export interface WaitingConsensus {
  readonly workflowId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly participantIds: readonly string[];
  readonly participantInstances: ReadonlyMap<
    string,
    { readonly scopeId: string; readonly authoredNodeId: string; readonly nodeInstanceId: string }
  >;
  readonly policy: ConsensusPolicy;
  readonly remaining: 'cancel' | 'drain';
  readonly timeoutMs?: number;
  state: ConsensusReductionState;
  resolved: boolean;
  verdict?: DurableConsensusVerdict;
}

type ConsensusEntry = Omit<WaitingConsensus, 'state' | 'resolved' | 'verdict'>;

export class ConsensusRegistry {
  private readonly entries = new Map<string, WaitingConsensus>();

  register(nodeInstanceId: string, entry: ConsensusEntry): void {
    if (this.entries.has(nodeInstanceId)) {
      return;
    }
    this.entries.set(nodeInstanceId, {
      ...entry,
      state: initialConsensusState(),
      resolved: false,
    });
  }

  registerResolved(nodeInstanceId: string, entry: ConsensusEntry): void {
    if (this.entries.has(nodeInstanceId)) {
      return;
    }
    this.entries.set(nodeInstanceId, {
      ...entry,
      state: initialConsensusState(),
      resolved: true,
    });
  }

  get(nodeInstanceId: string): WaitingConsensus | undefined {
    return this.entries.get(nodeInstanceId);
  }

  replaceState(nodeInstanceId: string, state: ConsensusReductionState): void {
    const entry = this.entries.get(nodeInstanceId);
    if (entry !== undefined) {
      entry.state = state;
    }
  }

  markResolved(nodeInstanceId: string, verdict?: DurableConsensusVerdict): void {
    const entry = this.entries.get(nodeInstanceId);
    if (entry === undefined) {
      return;
    }
    entry.resolved = true;
    if (verdict !== undefined) {
      entry.verdict = verdict;
    }
  }

  entriesForWorkflows(
    workflowIds: ReadonlySet<string>,
  ): ReadonlyArray<readonly [string, WaitingConsensus]> {
    return [...this.entries.entries()].filter(
      ([, entry]) => !entry.resolved && workflowIds.has(entry.workflowId),
    );
  }

  unresolved(): ReadonlyArray<readonly [string, WaitingConsensus]> {
    return [...this.entries.entries()].filter(([, entry]) => !entry.resolved);
  }
}

export const consensusEntryFromWaiting = (
  message: Extract<RunCoordinatorMessage, { readonly kind: 'consensusWaiting' }>,
): ConsensusEntry => ({
  workflowId: message.workflowId,
  scopeId: message.scopeId,
  authoredNodeId: message.authoredNodeId,
  pipelineId: message.pipelineId,
  nodePath: message.nodePath,
  participantIds: message.participantIds,
  participantInstances: new Map(
    message.participantInstances.map((instance) => [instance.participantId, instance]),
  ),
  policy: message.policy,
  remaining: message.remaining,
  ...(message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs }),
});
