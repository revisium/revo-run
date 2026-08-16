import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type { HumanGateResolutionDirective } from '../../contracts/workflow/run-command-workflow.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import { decideGateState } from '../../pipeline/human-gate/human-gate-policy.js';
import { humanGateResolutionTopic } from '../human-gate-names.js';
import { HumanGateRegistry, type WaitingHumanGate } from './human-gate-registry.js';
import type { OpenGateDecisionInput } from './run-command-decision.js';

export const waitingGateFenceDirective = (
  eventBudgetExceeded: boolean,
  cancellationRequested: boolean,
  subtreeFenced: boolean,
): 'cancel' | 'fail' | undefined =>
  eventBudgetExceeded ? 'fail' : cancellationRequested || subtreeFenced ? 'cancel' : undefined;

/**
 * Owns waiting-gate registration and the D-04 mark → send → append resolution order.
 * Extracted from RunCommandCoordinator so that file stays a command inbox, not a second
 * home for gate fan-out.
 */
export class HumanGateResolutions {
  private readonly humanGates = new HumanGateRegistry();

  async register(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'humanGateWaiting' }>,
    fenceDirective: 'cancel' | 'fail' | undefined,
  ): Promise<void> {
    const decision =
      message.decision.kind === 'firstAnswer'
        ? { kind: 'firstAnswer' as const }
        : {
            kind: 'matchingAnswers' as const,
            count: message.decision.count,
            onConflict: message.decision.onConflict,
          };
    const entry = {
      workflowId: message.workflowId,
      scopeId: message.scopeId,
      authoredNodeId: message.authoredNodeId,
      policy: {
        answers: message.answers,
        decision,
        ...(message.eligibleGroup === undefined ? {} : { eligibleGroup: message.eligibleGroup }),
      },
    };
    if (fenceDirective === undefined) {
      this.humanGates.register(message.gateInstanceId, entry);
      return;
    }
    // D-11: a gate that arrives at a fenced coordinator is already resolved. Send the matching
    // directive on the gate topic before the scope reply so a later park cannot wait forever.
    this.humanGates.registerResolved(message.gateInstanceId, entry);
    await DBOS.send(
      message.workflowId,
      { kind: fenceDirective },
      humanGateResolutionTopic(message.gateInstanceId),
    );
  }

  openGateDecisionInput(gateInstanceId: string): OpenGateDecisionInput | undefined {
    return this.humanGates.openGateDecisionInput(gateInstanceId);
  }

  async resolveDeadline(
    gateInstanceId: string,
    ownerWorkflowId: string,
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    const gate = this.humanGates.get(gateInstanceId);
    if (gate === undefined || gate.resolved || gate.workflowId !== ownerWorkflowId) {
      return;
    }
    await this.resolveGate(
      gateInstanceId,
      gate,
      { kind: 'timedOut' },
      { type: 'humanGate.timedOut', data: gateNodeIdentity(gateInstanceId, gate) },
      appendEvent,
    );
  }

  sendAll(
    directive: 'cancel' | 'fail',
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    return this.fanOut(
      [...this.humanGates.entries()].filter(([, gate]) => !gate.resolved),
      directive,
      appendEvent,
    );
  }

  sendForWorkflows(
    workflowIds: readonly string[],
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    const cancelledWorkflowIds = new Set(workflowIds);
    return this.fanOut(
      [...this.humanGates.entries()].filter(
        ([, gate]) => !gate.resolved && cancelledWorkflowIds.has(gate.workflowId),
      ),
      'cancel',
      appendEvent,
    );
  }

  async applyAcceptedAnswer(
    commandId: string,
    gateInstanceId: string,
    actorId: string,
    answer: string,
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    this.humanGates.addAccepted(gateInstanceId, { actorId, answer, commandId });
    const gate = this.humanGates.get(gateInstanceId);
    if (gate === undefined) {
      throw new Error('Accepted gate answer target is not registered.');
    }
    const state = decideGateState(gate.policy, gate.accepted);
    if (state.kind === 'pending') {
      return;
    }
    if (state.kind === 'resolved') {
      await this.resolveGate(
        gateInstanceId,
        gate,
        {
          kind: 'answered',
          answer: state.answer,
          commandIds: gate.accepted.map((entry) => entry.commandId),
        },
        undefined,
        appendEvent,
      );
      return;
    }
    await this.resolveGate(
      gateInstanceId,
      gate,
      { kind: 'conflict' },
      { type: 'humanGate.conflict', data: gateNodeIdentity(gateInstanceId, gate) },
      appendEvent,
    );
  }

  private async resolveGate(
    gateInstanceId: string,
    gate: WaitingHumanGate,
    directive: HumanGateResolutionDirective,
    event: RunEventDraft | undefined,
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    this.humanGates.markResolved(gateInstanceId);
    await DBOS.send(gate.workflowId, directive, humanGateResolutionTopic(gateInstanceId));
    if (event !== undefined) {
      await appendEvent(event);
    }
  }

  private async fanOut(
    targets: ReadonlyArray<readonly [string, WaitingHumanGate]>,
    directive: 'cancel' | 'fail',
    appendEvent: (event: RunEventDraft) => Promise<boolean>,
  ): Promise<void> {
    for (const [gateInstanceId] of targets) {
      this.humanGates.markResolved(gateInstanceId);
    }
    await targets.reduce<Promise<void>>(async (previous, [gateInstanceId, gate]) => {
      await previous;
      await DBOS.send(
        gate.workflowId,
        { kind: directive },
        humanGateResolutionTopic(gateInstanceId),
      );
    }, Promise.resolve());
    if (directive === 'fail') {
      return;
    }
    await targets.reduce<Promise<void>>(async (previous, [gateInstanceId, gate]) => {
      await previous;
      await appendEvent({
        type: 'humanGate.cancelled',
        data: gateNodeIdentity(gateInstanceId, gate),
      });
    }, Promise.resolve());
  }
}

const gateNodeIdentity = (
  gateInstanceId: string,
  gate: WaitingHumanGate,
): { scopeId: string; authoredNodeId: string; nodeInstanceId: string } => ({
  scopeId: gate.scopeId,
  authoredNodeId: gate.authoredNodeId,
  nodeInstanceId: gateInstanceId,
});
