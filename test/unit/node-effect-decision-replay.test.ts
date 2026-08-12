import { DBOS, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import { NodeExecutionStep } from '../../src/dbos/steps/node-execution-step.js';
import type { RunExecutor } from '../../src/index.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const workflowId = `rr:scope:v1:${'e'.repeat(43)}`;
const request = storedNodeExecution('main/root-work', 'completed').request;
const recovery = {
  reconciliation: 'required',
  maximumAttempts: 2,
  timeoutMs: 1_000,
  unknownOutcome: 'fail',
} as const;

const workflowStatus = (): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  priority: 0,
  recoveryAttempts: 2,
  status: 'PENDING',
  updatedAt: 1,
  workflowClassName: '',
  workflowID: workflowId,
  workflowName: 'revo-run.execution.v1',
});

const provider = () => {
  const execute = vi.fn<RunExecutor['execute']>();
  const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>();
  const value = new RunExecutorProvider();
  value.bind({ execute, reconcile });
  return { execute, reconcile, value };
};

describe('node effect decision replay semantics', () => {
  beforeEach(() => {
    vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(workflowId);
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(workflowStatus());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'stored generation differs from the intent',
      intentGeneration: 1,
      storedGeneration: 0,
      liveGeneration: 2,
    },
    {
      name: 'live generation equals the stored generation',
      intentGeneration: 1,
      storedGeneration: 1,
      liveGeneration: 1,
    },
    {
      name: 'live generation is lower than the stored generation',
      intentGeneration: 2,
      storedGeneration: 2,
      liveGeneration: 1,
    },
  ])('rejects when $name', async ({ intentGeneration, storedGeneration, liveGeneration }) => {
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: intentGeneration,
      })
      .mockResolvedValueOnce({
        kind: 'mustReconcile',
        request,
        storedRecoveryGeneration: storedGeneration,
        liveRecoveryGeneration: liveGeneration,
      });
    const executor = provider();
    const step = new NodeExecutionStep(executor.value);

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect decision generation is invalid.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });
});
