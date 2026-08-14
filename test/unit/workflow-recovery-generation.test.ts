import { DBOS, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentRecoveryGeneration } from '../../src/dbos/steps/workflow-recovery-generation.js';

const workflowId = `rr:scope:sc1_${'c'.repeat(43)}`;

const status = (overrides: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  priority: 0,
  recoveryAttempts: 1,
  status: 'PENDING',
  updatedAt: 1,
  workflowClassName: '',
  workflowID: workflowId,
  workflowName: 'revo-run.execution',
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workflow recovery generation', () => {
  it('rejects a missing workflow identity without reading status', async () => {
    vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(undefined);
    const getStatus = vi.spyOn(DBOS, 'getWorkflowStatus');

    await expect(currentRecoveryGeneration()).rejects.toThrow(
      'Node effect has no DBOS workflow identity.',
    );
    expect(getStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['missing status', null],
    ['foreign workflow identity', status({ workflowID: `rr:scope:sc1_${'d'.repeat(43)}` })],
    ['foreign workflow kind', status({ workflowName: 'foreign.workflow' })],
    ['unsafe generation', status({ recoveryAttempts: Number.MAX_SAFE_INTEGER + 1 })],
  ])('rejects %s', async (_case, workflowStatus) => {
    vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(workflowId);
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(workflowStatus);

    await expect(currentRecoveryGeneration()).rejects.toThrow(
      'Node effect recovery generation is invalid.',
    );
  });

  it('rejects a missing generation in an otherwise valid status', async () => {
    const { recoveryAttempts: _recoveryAttempts, ...missingGeneration } = status();
    vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(workflowId);
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(missingGeneration);

    await expect(currentRecoveryGeneration()).rejects.toThrow(
      'Node effect recovery generation is invalid.',
    );
  });
});
