import type { ScopeStartFenceReply } from '../../contracts/workflow/run-coordinator-message.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import type { RunEventBudgetFailure } from '../streams/run-event-stream.js';
import type { RunScopeRegistry } from './run-scope-registry.js';
import type { ScopeCancellationRegistry } from './scope-cancellation-registry.js';

export interface ScopeAdmissionFence {
  readonly cancellationCommandId?: string;
  readonly cancellationRequested: boolean;
  readonly eventBudgetFailure?: RunEventBudgetFailure;
}

/** Owns deterministic child admission identity and the pre-start cancellation fence. */
export class RunScopeAdmission {
  constructor(
    private readonly runId: string,
    private readonly scopes: RunScopeRegistry,
    private readonly cancellation: ScopeCancellationRegistry,
  ) {}

  async admit(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'scopeAdmission' }>,
    fence: ScopeAdmissionFence,
  ): Promise<void> {
    const admissionId = `admission:${message.workflowId}`;
    this.scopes.admitChild(
      message.workflowId,
      message.parentWorkflowId,
      message.requestId,
      admissionId,
    );
    const reply = this.startFence(message.workflowId, message.requestId, admissionId, fence);
    await this.scopes.replyAdmission(message.parentWorkflowId, reply);
    if (reply.directive === 'startCancelled') {
      this.cancellation.cancelScope(this.scopeId(message.workflowId));
    }
  }

  private startFence(
    workflowId: string,
    requestId: string,
    admissionId: string,
    fence: ScopeAdmissionFence,
  ): ScopeStartFenceReply {
    if (fence.eventBudgetFailure !== undefined) {
      return {
        directive: 'startCancelled',
        workflowId,
        requestId,
        admissionId,
        cancellation: { source: 'run', id: fence.eventBudgetFailure },
      };
    }
    if (fence.cancellationRequested) {
      return {
        directive: 'startCancelled',
        workflowId,
        requestId,
        admissionId,
        cancellation: {
          source: 'run',
          id: fence.cancellationCommandId ?? `cancel:${this.runId}`,
        },
      };
    }
    const inherited = this.scopes.cancellationFence(workflowId);
    if (inherited !== undefined) {
      return {
        directive: 'startCancelled',
        workflowId,
        requestId,
        admissionId,
        cancellation: inherited,
      };
    }
    return { directive: 'start', workflowId, requestId, admissionId };
  }

  private scopeId(workflowId: string): string {
    return workflowId.slice('rr:scope:'.length);
  }
}
