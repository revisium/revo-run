import { DBOS } from '@dbos-inc/dbos-sdk';

import type { ScopeDirective } from '../../contracts/workflow/run-command-workflow.js';
import { scopeDirectiveV2Topic, scopeReplyV2Topic, scopeSettlementV2Topic } from '../dbos-names.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';

/** Root-owned registry for readiness, fencing, and cooperative scope settlement. */
export class RunScopeRegistry {
  private readonly parents = new Map<string, string>();
  private readonly ready = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly settled = new Set<string>();

  registerRoot(workflowId: string, rootWorkflowId: string): void {
    this.register(workflowId, rootWorkflowId, false);
    this.ready.add(workflowId);
  }

  registerChild(workflowId: string, parentWorkflowId: string): void {
    if (!this.parents.has(parentWorkflowId)) {
      throw new Error('Run scope parent is not registered.');
    }
    this.register(workflowId, parentWorkflowId, true);
  }

  assertLineage(workflowId: string, parentWorkflowId: string): void {
    if (this.parents.get(workflowId) !== parentWorkflowId) {
      throw new Error('Run scope lineage is invalid.');
    }
  }

  assertRegistered(workflowId: string): void {
    if (!this.parents.has(workflowId)) {
      throw new Error('Run scope is not registered.');
    }
  }

  markReady(workflowId: string): void {
    this.assertRegistered(workflowId);
    this.ready.add(workflowId);
  }

  settle(workflowId: string): void {
    this.assertRegistered(workflowId);
    this.settled.add(workflowId);
  }

  finish(workflowId: string): void {
    this.assertRegistered(workflowId);
    this.finished.add(workflowId);
  }

  allSettled(rootWorkflowId: string): boolean {
    return (
      this.settled.has(rootWorkflowId) &&
      [...this.parents.keys()].every((workflowId) => this.settled.has(workflowId))
    );
  }

  direct(workflowId: string, directive: ScopeDirective): Promise<void> {
    return DBOS.send(workflowId, directive, scopeDirectiveV2Topic);
  }

  reply(workflowId: string, directive: ScopeDirective): Promise<void> {
    return DBOS.send(workflowId, directive, scopeReplyV2Topic);
  }

  acknowledgeSettlement(workflowId: string): Promise<void> {
    return DBOS.send(workflowId, { kind: 'settled' }, scopeSettlementV2Topic);
  }

  async directAll(directive: ScopeDirective): Promise<void> {
    await this.directNext([...this.parents.keys()], directive);
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

  private async directNext(
    workflowIds: readonly string[],
    directive: ScopeDirective,
  ): Promise<void> {
    const [workflowId, ...remaining] = workflowIds;
    if (workflowId === undefined) {
      return;
    }
    if (
      this.ready.has(workflowId) &&
      !this.finished.has(workflowId) &&
      !this.settled.has(workflowId)
    ) {
      await this.direct(workflowId, directive);
    }
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
