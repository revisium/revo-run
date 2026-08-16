import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import { runCoordinatorReplyTopic } from '../dbos-names.js';

interface RetainedReservation {
  readonly granted: boolean;
  readonly permitCommandId?: string;
}

export interface ExecutionReservationContext {
  readonly fenced: boolean;
  readonly scopeCancelled: boolean;
  consumeRetryPermit(commandId: string, attemptId: string): boolean;
}

/** Root-owned execution admission: retained per-attempt reservations and the run's execution counter. */
export class RunExecutionReservations {
  private readonly reservations = new Map<string, RetainedReservation>();
  private executionCount = 0;

  constructor(private readonly maximumExecutions: number) {}

  get executions(): number {
    return this.executionCount;
  }

  consumeExecution(): void {
    this.executionCount += 1;
  }

  async reserve(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'reserveExecution' }>,
    context: ExecutionReservationContext,
  ): Promise<void> {
    const retained = this.reservations.get(message.attemptId);
    if (retained !== undefined) {
      if (retained.permitCommandId !== message.permitCommandId) {
        throw new Error('Execution reservation was replayed with a different permit.');
      }
      await this.reply(message, retained.granted);
      return;
    }

    let granted = false;
    if (!context.fenced && !context.scopeCancelled && message.permitCommandId !== undefined) {
      granted = context.consumeRetryPermit(message.permitCommandId, message.attemptId);
    } else if (
      !context.fenced &&
      !context.scopeCancelled &&
      this.executionCount < this.maximumExecutions
    ) {
      this.executionCount += 1;
      granted = true;
    }
    this.reservations.set(message.attemptId, {
      granted,
      ...(message.permitCommandId === undefined
        ? {}
        : { permitCommandId: message.permitCommandId }),
    });
    await this.reply(message, granted);
  }

  private reply(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'reserveExecution' }>,
    granted: boolean,
  ): Promise<void> {
    return DBOS.send(
      message.replyWorkflowId,
      { attemptId: message.attemptId, granted },
      runCoordinatorReplyTopic,
    );
  }
}
