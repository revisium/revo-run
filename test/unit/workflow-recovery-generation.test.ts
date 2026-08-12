import { DBOS, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import { NodeExecutionStep } from '../../src/dbos/steps/node-execution-step.js';
import { currentRecoveryGeneration } from '../../src/dbos/steps/workflow-recovery-generation.js';
import type { RunExecutor } from '../../src/index.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const workflowId = `rr:scope:v1:${'c'.repeat(43)}`;
const request = storedNodeExecution('main/root-work', 'completed').request;
const recovery = {
  reconciliation: 'required',
  maximumAttempts: 2,
  timeoutMs: 1_000,
  unknownOutcome: 'fail',
} as const;

const status = (overrides: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  priority: 0,
  recoveryAttempts: 1,
  status: 'PENDING',
  updatedAt: 1,
  workflowClassName: '',
  workflowID: workflowId,
  workflowName: 'revo-run.execution.v1',
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
    ['foreign workflow identity', status({ workflowID: `rr:scope:v1:${'d'.repeat(43)}` })],
    ['foreign workflow kind', status({ workflowName: 'foreign.workflow.v1' })],
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

  it('rejects a decreasing generation before execute or reconcile', async () => {
    vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(workflowId);
    vi.spyOn(DBOS, 'stepStatus', 'get').mockReturnValue({
      stepID: 1,
      timeoutSignal: new AbortController().signal,
    });
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(status());
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 2,
      })
      .mockImplementation(async (callback) => callback());
    const execute = vi.fn<RunExecutor['execute']>();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>();
    const provider = new RunExecutorProvider();
    provider.bind({ execute, reconcile });

    await expect(
      new NodeExecutionStep(provider).execute(request, 1_000, recovery, 1),
    ).rejects.toThrow('Node effect recovery generation decreased.');
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
