import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';

interface DelayCancellationEventContext {
  readonly cancellationRequested: boolean;
  readonly eventBudgetExceeded: boolean;
  readonly senderCancelled: boolean;
  readonly senderOwnsScope: boolean;
  readonly appendEvent: (event: RunEventDraft) => Promise<boolean>;
}

export class DelayCancellationEventAdmission {
  private readonly accepted = new Set<string>();

  async appendIfAllowed(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'event' }>,
    context: DelayCancellationEventContext,
  ): Promise<void> {
    if (
      context.eventBudgetExceeded ||
      !context.cancellationRequested ||
      !context.senderCancelled ||
      !context.senderOwnsScope ||
      message.event.type !== 'delay.cancelled'
    ) {
      return;
    }
    const dedupeKey = `delay.cancelled:${message.event.data.nodeInstanceId}`;
    if (this.accepted.has(dedupeKey)) {
      return;
    }
    if (await context.appendEvent(message.event)) {
      this.accepted.add(dedupeKey);
    }
  }
}
