import { DBOS } from '@dbos-inc/dbos-sdk';

import type { ScopeDirective } from '../../contracts/workflow/run-command-workflow.js';
import type { ScopeStartFenceReply } from '../../contracts/workflow/run-coordinator-message.js';
import {
  scopeAdmissionReplyTopic,
  scopeDirectiveTopic,
  scopeReplyTopic,
  scopeSettlementTopic,
} from '../dbos-names.js';
import type { RunScopeRegistry } from './run-scope-registry.js';

export class RunScopeDirectives {
  constructor(private readonly scopes: RunScopeRegistry) {}

  reply(workflowId: string, directive: ScopeDirective): Promise<void> {
    return DBOS.send(workflowId, directive, scopeReplyTopic);
  }

  replyAdmission(parentWorkflowId: string, reply: ScopeStartFenceReply): Promise<void> {
    return DBOS.send(parentWorkflowId, reply, scopeAdmissionReplyTopic(reply.workflowId));
  }

  acknowledgeSettlement(workflowId: string): Promise<void> {
    return DBOS.send(workflowId, { kind: 'settled' }, scopeSettlementTopic);
  }

  async directAll(directive: ScopeDirective): Promise<void> {
    await this.directNext(this.scopes.registeredWorkflowIds(), directive);
  }

  async directMany(workflowIds: readonly string[], directive: ScopeDirective): Promise<void> {
    await this.directNext(workflowIds, directive);
  }

  private async direct(workflowId: string, directive: ScopeDirective): Promise<void> {
    if (this.scopes.acceptsDirective(workflowId)) {
      await DBOS.send(workflowId, directive, scopeDirectiveTopic);
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
}
