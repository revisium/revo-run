import { DBOS } from '@dbos-inc/dbos-sdk';

import type { ScopeDirective } from '../../contracts/workflow/run-command-workflow.js';
import type {
  ScopeCancellationFence,
  ScopeStartFenceReply,
} from '../../contracts/workflow/run-coordinator-message.js';
import { createSubpipelineScopeId } from '../../pipeline/identity/execution-identity.js';
import {
  scopeAdmissionReplyTopic,
  scopeDirectiveTopic,
  scopeReplyTopic,
  scopeSettlementTopic,
} from '../dbos-names.js';
import { scopeWorkflowId } from '../workflow-id.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';

interface InlineScopeOwnershipClaim {
  readonly workflowId: string;
  readonly parentScopeId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly invocationOrdinal: number;
}

/** Root-owned lineage, cancellation fence, and settlement-obligation registry. */
export class RunScopeRegistry {
  private readonly parents = new Map<string, string>();
  private readonly admissions = new Map<
    string,
    { readonly requestId: string; readonly admissionId: string }
  >();
  private readonly ready = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly settled = new Set<string>();
  private readonly cancellationFences = new Map<string, ScopeCancellationFence>();
  private readonly inlineOwnership = new Map<string, InlineScopeOwnershipClaim>();

  registerRoot(workflowId: string, rootWorkflowId: string): void {
    this.register(workflowId, rootWorkflowId, false);
    this.ready.add(workflowId);
  }

  admitChild(
    workflowId: string,
    parentWorkflowId: string,
    requestId: string,
    admissionId: string,
  ): void {
    if (!this.parents.has(parentWorkflowId)) {
      throw new Error('Run scope parent is not registered.');
    }
    this.register(workflowId, parentWorkflowId, true);
    const existing = this.admissions.get(workflowId);
    if (
      existing !== undefined &&
      (existing.requestId !== requestId || existing.admissionId !== admissionId)
    ) {
      throw new Error('Run scope admission was replayed with conflicting identity.');
    }
    this.admissions.set(workflowId, { requestId, admissionId });
    if (this.cancellationFences.has(parentWorkflowId)) {
      this.retainCancellation(workflowId, { source: 'parent', id: parentWorkflowId });
    }
  }

  assertLineage(workflowId: string, parentWorkflowId: string): void {
    if (this.parents.get(workflowId) !== parentWorkflowId) {
      throw new Error('Run scope lineage is invalid.');
    }
  }

  assertAdmission(workflowId: string, requestId: string, admissionId: string): void {
    const admission = this.admissions.get(workflowId);
    if (admission?.requestId !== requestId || admission.admissionId !== admissionId) {
      throw new Error('Run scope readiness has invalid admission identity.');
    }
  }

  assertDirectChildren(parentWorkflowId: string, childWorkflowIds: readonly string[]): void {
    this.assertRegistered(parentWorkflowId);
    for (const workflowId of childWorkflowIds) {
      if (this.parents.get(workflowId) !== parentWorkflowId) {
        throw new Error('Parallel cancellation target has invalid lineage.');
      }
    }
  }

  assertRegistered(workflowId: string): void {
    if (!this.parents.has(workflowId)) {
      throw new Error('Run scope is not registered.');
    }
  }

  registerInlineOwnership(claim: InlineScopeOwnershipClaim): void {
    this.assertLive(claim.workflowId);
    if (!this.ownsScope(claim.workflowId, claim.parentScopeId)) {
      throw new Error('Inline scope parent is not owned by its physical workflow.');
    }
    const existing = this.inlineOwnership.get(claim.scopeId);
    if (existing !== undefined) {
      if (!this.sameInlineClaim(existing, claim)) {
        throw new Error('Inline scope ownership was replayed with conflicting identity.');
      }
      return;
    }
    const expectedScopeId = createSubpipelineScopeId({
      parentScopeId: claim.parentScopeId,
      authoredNodeId: claim.authoredNodeId,
      invocationOrdinal: claim.invocationOrdinal,
    });
    if (claim.scopeId !== expectedScopeId) {
      throw new Error('Inline scope ownership has forged deterministic identity.');
    }
    this.inlineOwnership.set(claim.scopeId, claim);
  }

  ownsScope(workflowId: string, scopeId: string): boolean {
    if (!this.parents.has(workflowId)) {
      return false;
    }
    return (
      workflowId === scopeWorkflowId(scopeId) ||
      this.inlineOwnership.get(scopeId)?.workflowId === workflowId
    );
  }

  markReady(workflowId: string): void {
    this.assertRegistered(workflowId);
    this.ready.add(workflowId);
  }

  finish(workflowId: string): void {
    this.assertRegistered(workflowId);
    this.finished.add(workflowId);
  }

  settle(workflowId: string): void {
    this.assertRegistered(workflowId);
    this.settled.add(workflowId);
  }

  allSettled(rootWorkflowId: string): boolean {
    return (
      this.settled.has(rootWorkflowId) &&
      [...this.parents.keys()].every((workflowId) => this.settled.has(workflowId))
    );
  }

  cancellationFence(workflowId: string): ScopeCancellationFence | undefined {
    this.assertRegistered(workflowId);
    return this.cancellationFences.get(workflowId);
  }

  directive(workflowId: string, global: ScopeDirective): ScopeDirective {
    return global.kind === 'continue' && this.cancellationFence(workflowId) !== undefined
      ? { kind: 'cancel' }
      : global;
  }

  cancelSubtrees(workflowIds: readonly string[], cause: ScopeCancellationFence): readonly string[] {
    const cancelled: string[] = [];
    for (const workflowId of workflowIds) {
      this.retainCancellation(workflowId, cause);
      cancelled.push(workflowId);
      this.cancelDescendants(workflowId, cancelled);
    }
    return cancelled;
  }

  cancelAll(cause: ScopeCancellationFence): void {
    for (const workflowId of this.parents.keys()) {
      this.cancellationFences.set(workflowId, cause);
    }
  }

  reply(workflowId: string, directive: ScopeDirective): Promise<void> {
    return DBOS.send(workflowId, directive, scopeReplyTopic);
  }

  replyAdmission(parentWorkflowId: string, reply: ScopeStartFenceReply): Promise<void> {
    return DBOS.send(parentWorkflowId, reply, scopeAdmissionReplyTopic(reply.workflowId));
  }

  acknowledgeSettlement(workflowId: string): Promise<void> {
    return DBOS.send(workflowId, { kind: 'settled' }, scopeSettlementTopic);
  }

  async direct(workflowId: string, directive: ScopeDirective): Promise<void> {
    this.assertRegistered(workflowId);
    if (
      this.ready.has(workflowId) &&
      !this.finished.has(workflowId) &&
      !this.settled.has(workflowId)
    ) {
      await DBOS.send(workflowId, directive, scopeDirectiveTopic);
    }
  }

  async directAll(directive: ScopeDirective): Promise<void> {
    await this.directNext([...this.parents.keys()], directive);
  }

  async directMany(workflowIds: readonly string[], directive: ScopeDirective): Promise<void> {
    await this.directNext(workflowIds, directive);
  }

  async assertUnsettledActive(): Promise<void> {
    await this.assertNextActive([...this.parents.keys()]);
  }

  private register(workflowId: string, parentWorkflowId: string, child: boolean): void {
    const existing = this.parents.get(workflowId);
    if (existing !== undefined && existing !== parentWorkflowId) {
      throw new Error('Run scope was registered with conflicting lineage.');
    }
    if (child && workflowId === parentWorkflowId) {
      throw new Error('Run scope cannot own itself.');
    }
    this.parents.set(workflowId, parentWorkflowId);
  }

  private assertLive(workflowId: string): void {
    this.assertRegistered(workflowId);
    if (
      !this.ready.has(workflowId) ||
      this.finished.has(workflowId) ||
      this.settled.has(workflowId)
    ) {
      throw new Error('Inline scope physical workflow is not live.');
    }
  }

  private sameInlineClaim(
    left: InlineScopeOwnershipClaim,
    right: InlineScopeOwnershipClaim,
  ): boolean {
    return (
      left.workflowId === right.workflowId &&
      left.parentScopeId === right.parentScopeId &&
      left.scopeId === right.scopeId &&
      left.authoredNodeId === right.authoredNodeId &&
      left.invocationOrdinal === right.invocationOrdinal
    );
  }

  private retainCancellation(workflowId: string, cause: ScopeCancellationFence): void {
    this.assertRegistered(workflowId);
    const existing = this.cancellationFences.get(workflowId);
    if (
      existing?.source === 'run' ||
      (existing?.source === 'parent' && cause.source === 'joinDecision')
    ) {
      return;
    }
    this.cancellationFences.set(workflowId, cause);
  }

  private cancelDescendants(parentWorkflowId: string, cancelled: string[]): void {
    for (const [workflowId, parent] of this.parents) {
      if (parent !== parentWorkflowId) {
        continue;
      }
      this.retainCancellation(workflowId, { source: 'parent', id: parentWorkflowId });
      cancelled.push(workflowId);
      this.cancelDescendants(workflowId, cancelled);
    }
  }

  private async directNext(
    workflowIds: readonly string[],
    directive: ScopeDirective,
  ): Promise<void> {
    const [workflowId, ...remaining] = workflowIds;
    if (workflowId === undefined) {
      return;
    }
    await this.direct(workflowId, directive);
    await this.directNext(remaining, directive);
  }

  private async assertNextActive(workflowIds: readonly string[]): Promise<void> {
    const [workflowId, ...remaining] = workflowIds;
    if (workflowId === undefined) {
      return;
    }
    if (!this.settled.has(workflowId)) {
      const status = await DBOS.getWorkflowStatus(workflowId);
      if (status === null || !isActiveWorkflowStatus(status.status)) {
        throw new Error(`Run scope ${workflowId} terminated without settlement.`);
      }
    }
    await this.assertNextActive(remaining);
  }
}
