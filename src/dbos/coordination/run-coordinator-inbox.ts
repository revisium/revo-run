import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import type { RunEventBudgetFailure } from '../streams/run-event-stream.js';
import {
  waitingConsensusFenceDirective,
  type ConsensusCoordination,
} from './consensus-coordination.js';
import { DelayCancellationEventAdmission } from './delay-cancellation-event-admission.js';
import { waitingGateFenceDirective } from './human-gate-resolutions.js';
import type { RunCommandCoordinator } from './run-command-coordinator.js';
import type { RunScopeAdmission } from './run-scope-admission.js';
import type { RunScopeRegistry } from './run-scope-registry.js';

export interface RunCoordinatorInboxPorts {
  readonly scopes: RunScopeRegistry;
  readonly commands: RunCommandCoordinator;
  readonly admissions: RunScopeAdmission;
  readonly consensus: ConsensusCoordination;
  readonly delayCancellationEvents: DelayCancellationEventAdmission;
  readonly cancellationRequested: boolean;
  readonly cancellationCommandId?: string;
  readonly eventBudgetFailure?: RunEventBudgetFailure;
  readonly fenced: boolean;
  appendEvent(event: RunEventDraft): Promise<boolean>;
  replyScope(workflowId: string): Promise<void>;
  reserveExecution(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'reserveExecution' }>,
  ): Promise<void>;
  cancelChildScopes(
    parentWorkflowId: string,
    childWorkflowIds: readonly string[],
    joinNodeInstanceId: string,
  ): Promise<void>;
  finishScope(workflowId: string): Promise<void>;
  commandContext(): Parameters<RunCommandCoordinator['decide']>[1];
}

export const processCoordinatorInbox = async (
  ports: RunCoordinatorInboxPorts,
  message: RunCoordinatorMessage,
): Promise<void> => {
  if ('command' in message) {
    await ports.commands.decide(message, ports.commandContext());
    return;
  }
  switch (message.kind) {
    case 'event':
      ports.scopes.assertRegistered(message.workflowId);
      if (!ports.fenced) {
        await ports.appendEvent(message.event);
      } else {
        await ports.delayCancellationEvents.appendIfAllowed(message, {
          cancellationRequested: ports.cancellationRequested,
          eventBudgetExceeded: ports.eventBudgetFailure !== undefined,
          senderCancelled: ports.scopes.cancellationFence(message.workflowId) !== undefined,
          senderOwnsScope: ports.scopes.ownsScope(message.workflowId, message.event.data.scopeId),
          appendEvent: (event) => ports.appendEvent(event),
        });
      }
      await ports.replyScope(message.workflowId);
      return;
    case 'reserveExecution':
      await ports.reserveExecution(message);
      return;
    case 'scopeAdmission':
      await ports.admissions.admit(message, {
        cancellationRequested: ports.cancellationRequested,
        ...(ports.cancellationCommandId === undefined
          ? {}
          : { cancellationCommandId: ports.cancellationCommandId }),
        ...(ports.eventBudgetFailure === undefined
          ? {}
          : { eventBudgetFailure: ports.eventBudgetFailure }),
      });
      return;
    case 'scopeReady':
      ports.scopes.assertLineage(message.workflowId, message.parentWorkflowId);
      if ('requestId' in message) {
        ports.scopes.assertAdmission(message.workflowId, message.requestId, message.admissionId);
      }
      ports.scopes.markReady(message.workflowId);
      await ports.replyScope(message.workflowId);
      return;
    case 'scopeBoundary':
      ports.scopes.assertRegistered(message.workflowId);
      await ports.replyScope(message.workflowId);
      return;
    case 'inlineScopeOwnership':
      ports.scopes.registerInlineOwnership(message);
      await ports.replyScope(message.workflowId);
      return;
    case 'scopeCancellation':
      await ports.cancelChildScopes(
        message.workflowId,
        message.childWorkflowIds,
        message.joinNodeInstanceId,
      );
      return;
    case 'scopeFinish':
      await ports.finishScope(message.workflowId);
      return;
    case 'scopeSettled':
      ports.scopes.settle(message.workflowId);
      await ports.scopes.acknowledgeSettlement(message.workflowId);
      return;
    case 'unknownOutcomeWaiting':
      ports.scopes.assertRegistered(message.workflowId);
      ports.commands.registerUnknownOutcome(message);
      await ports.replyScope(message.workflowId);
      return;
    case 'humanGateWaiting':
      ports.scopes.assertRegistered(message.workflowId);
      await ports.commands.registerHumanGate(
        message,
        waitingGateFenceDirective(
          ports.eventBudgetFailure !== undefined,
          ports.cancellationRequested,
          ports.scopes.cancellationFence(message.workflowId) !== undefined,
        ),
      );
      await ports.replyScope(message.workflowId);
      return;
    case 'humanGateDeadlineReached':
      ports.scopes.assertRegistered(message.workflowId);
      await ports.commands.resolveGateDeadline(
        message.gateInstanceId,
        message.workflowId,
        (event) => ports.appendEvent(event),
      );
      return;
    case 'consensusWaiting':
      ports.scopes.assertRegistered(message.workflowId);
      await ports.consensus.register(
        message,
        waitingConsensusFenceDirective(
          ports.eventBudgetFailure !== undefined,
          ports.cancellationRequested,
          ports.scopes.cancellationFence(message.workflowId) !== undefined,
        ),
      );
      await ports.replyScope(message.workflowId);
      return;
    case 'consensusParticipantSettled':
      ports.scopes.assertRegistered(message.workflowId);
      await ports.consensus.admitSettlement(message, (event) => ports.appendEvent(event));
      return;
    case 'consensusDeadlineReached':
      ports.scopes.assertRegistered(message.workflowId);
      await ports.consensus.resolveDeadline(message, (event) => ports.appendEvent(event));
      return;
  }
};
