import { DBOS } from '@dbos-inc/dbos-sdk';

import { isActiveWorkflowStatus } from '../workflow-status.js';
import type { RunScopeRegistry } from './run-scope-registry.js';

export const assertUnsettledScopesActive = async (
  scopes: Pick<RunScopeRegistry, 'registeredWorkflowIds' | 'isSettled'>,
): Promise<void> => {
  await assertNextActive(scopes, scopes.registeredWorkflowIds());
};

const assertNextActive = async (
  scopes: Pick<RunScopeRegistry, 'isSettled'>,
  workflowIds: readonly string[],
): Promise<void> => {
  const [workflowId, ...remaining] = workflowIds;
  if (workflowId === undefined) {
    return;
  }
  if (!scopes.isSettled(workflowId)) {
    const status = await DBOS.getWorkflowStatus(workflowId);
    if (status === null || !isActiveWorkflowStatus(status.status)) {
      throw new Error(`Run scope ${workflowId} terminated without settlement.`);
    }
  }
  await assertNextActive(scopes, remaining);
};
