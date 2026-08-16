import type { HumanGateAuthoredPolicy } from '../../pipeline/human-gate/human-gate-policy.js';
import type { OpenGateDecisionInput } from './run-command-decision.js';

export interface HumanGateAcceptedAnswerRecord {
  readonly actorId: string;
  readonly answer: string;
  readonly commandId: string;
}

export interface WaitingHumanGate {
  readonly workflowId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly policy: HumanGateAuthoredPolicy;
  readonly accepted: HumanGateAcceptedAnswerRecord[];
  resolved: boolean;
}

type HumanGateEntry = Omit<WaitingHumanGate, 'accepted' | 'resolved'>;

/**
 * Replay-local waiting-gate state owned exclusively by the root run coordinator, a sibling of
 * UnknownOutcomeRegistry. INVARIANT: entries are append-and-mark and are NEVER deleted - a gate
 * once registered stays discoverable, resolved or not, for the life of the run (decision D-12).
 */
export class HumanGateRegistry {
  private readonly gates = new Map<string, WaitingHumanGate>();

  register(gateInstanceId: string, entry: HumanGateEntry): void {
    if (this.gates.has(gateInstanceId)) {
      return;
    }
    this.gates.set(gateInstanceId, { ...entry, accepted: [], resolved: false });
  }

  registerResolved(gateInstanceId: string, entry: HumanGateEntry): void {
    if (this.gates.has(gateInstanceId)) {
      return;
    }
    this.gates.set(gateInstanceId, { ...entry, accepted: [], resolved: true });
  }

  get(gateInstanceId: string): WaitingHumanGate | undefined {
    return this.gates.get(gateInstanceId);
  }

  openGateDecisionInput(gateInstanceId: string): OpenGateDecisionInput | undefined {
    const gate = this.gates.get(gateInstanceId);
    if (gate === undefined || gate.resolved) {
      return undefined;
    }
    return {
      policy: gate.policy,
      accepted: gate.accepted.map(({ actorId, answer }) => ({ actorId, answer })),
    };
  }

  addAccepted(gateInstanceId: string, answer: HumanGateAcceptedAnswerRecord): void {
    const gate = this.gates.get(gateInstanceId);
    if (gate === undefined) {
      throw new Error('Accepted gate answer target is not registered.');
    }
    gate.accepted.push(answer);
  }

  markResolved(gateInstanceId: string): void {
    const gate = this.gates.get(gateInstanceId);
    if (gate !== undefined) {
      gate.resolved = true;
    }
  }

  entries(): IterableIterator<[string, WaitingHumanGate]> {
    return this.gates.entries();
  }
}
