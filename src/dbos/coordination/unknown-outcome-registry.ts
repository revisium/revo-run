import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RetryPolicy } from '../../contracts/pipeline/task-policy.js';

export interface WaitingUnknownOutcome {
  readonly workflowId: string;
  readonly request: RunExecutorRequest;
  readonly reconciliationRound: number;
  readonly retry?: RetryPolicy;
  resolved: boolean;
}

interface RetryPermit {
  readonly commandId: string;
  readonly oldAttemptId: string;
  readonly newAttemptId: string;
  consumed: boolean;
}

/** Replay-local state owned exclusively by the root run coordinator. */
export class UnknownOutcomeRegistry {
  private readonly waiting = new Map<string, WaitingUnknownOutcome>();
  private readonly retryPermits = new Map<string, RetryPermit>();

  register(
    workflowId: string,
    request: RunExecutorRequest,
    reconciliationRound: number,
    retry?: RetryPolicy,
  ): void {
    this.waiting.set(request.attemptId, {
      workflowId,
      request,
      reconciliationRound,
      ...(retry === undefined ? {} : { retry }),
      resolved: false,
    });
  }

  get(attemptId: string): WaitingUnknownOutcome | undefined {
    return this.waiting.get(attemptId);
  }

  markResolved(attemptId: string): WaitingUnknownOutcome | undefined {
    const waiting = this.waiting.get(attemptId);
    if (waiting !== undefined) {
      waiting.resolved = true;
    }
    return waiting;
  }

  attemptIds(): IterableIterator<string> {
    return this.waiting.keys();
  }

  addRetryPermit(commandId: string, oldAttemptId: string, newAttemptId: string): void {
    this.retryPermits.set(commandId, {
      commandId,
      oldAttemptId,
      newAttemptId,
      consumed: false,
    });
  }

  consumeRetryPermit(commandId: string, attemptId: string): boolean {
    const permit = this.retryPermits.get(commandId);
    if (permit === undefined || permit.newAttemptId !== attemptId) {
      return false;
    }
    if (permit.consumed) {
      return true;
    }
    permit.consumed = true;
    return true;
  }

  cancelRetryPermits(): void {
    for (const permit of this.retryPermits.values()) {
      permit.consumed = true;
    }
  }
}
