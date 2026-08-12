import { DBOS, Error as DBOSError, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import { NodeExecutionStep } from '../../src/dbos/steps/node-execution-step.js';
import type { RunExecutor, RunExecutorRequest } from '../../src/index.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const workflowId = `rr:scope:v1:${'a'.repeat(43)}`;
const request = storedNodeExecution('main/root-work', 'completed').request;
const foreignRequest: RunExecutorRequest = {
  ...request,
  input: { foreign: { kind: 'json', value: true } },
};
const recovery = {
  reconciliation: 'required',
  maximumAttempts: 2,
  timeoutMs: 1_000,
  unknownOutcome: 'fail',
} as const;

const workflowStatus = (recoveryAttempts = 1): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  priority: 0,
  recoveryAttempts,
  status: 'PENDING',
  updatedAt: 1,
  workflowClassName: '',
  workflowID: workflowId,
  workflowName: 'revo-run.execution.v1',
});

const executorProvider = (executor: RunExecutor): RunExecutorProvider => {
  const provider = new RunExecutorProvider();
  provider.bind(executor);
  return provider;
};

describe('node effect recovery replay boundary', () => {
  beforeEach(() => {
    vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(workflowId);
    vi.spyOn(DBOS, 'stepStatus', 'get').mockReturnValue({
      stepID: 1,
      timeoutSignal: new AbortController().signal,
    });
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(workflowStatus());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a malformed replayed intent before provider work', async () => {
    const execute = vi.fn<RunExecutor['execute']>();
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: -1,
      })
      .mockImplementation(async (callback) => callback());
    const step = new NodeExecutionStep(
      executorProvider({
        execute,
        reconcile: async () => ({ kind: 'effectNotFound' }),
      }),
    );

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect intent is invalid.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a replayed intent whose nested request differs from the expected request', async () => {
    const execute = vi.fn<RunExecutor['execute']>();
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request: foreignRequest,
        recoveryGeneration: 1,
      })
      .mockImplementation(async (callback) => callback());
    const step = new NodeExecutionStep(executorProvider({ execute }));

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect request does not match the expected request.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a malformed replayed decision before provider work', async () => {
    const execute = vi.fn<RunExecutor['execute']>();
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 0,
      })
      .mockResolvedValueOnce({
        kind: 'mustReconcile',
        request,
        storedRecoveryGeneration: 0,
        liveRecoveryGeneration: 1,
        extra: true,
      });
    const step = new NodeExecutionStep(executorProvider({ execute }));

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect decision is invalid.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a replayed decision whose complete request differs', async () => {
    const execute = vi.fn<RunExecutor['execute']>();
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 0,
      })
      .mockResolvedValueOnce({
        kind: 'mustReconcile',
        request: foreignRequest,
        storedRecoveryGeneration: 0,
        liveRecoveryGeneration: 1,
      });
    const step = new NodeExecutionStep(executorProvider({ execute }));

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect request does not match the expected request.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a replayed reconciliation whose request differs', async () => {
    const execute = vi.fn<RunExecutor['execute']>();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>();
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 0,
      })
      .mockResolvedValueOnce({
        kind: 'mustReconcile',
        request,
        storedRecoveryGeneration: 0,
        liveRecoveryGeneration: 1,
      })
      .mockResolvedValueOnce({
        kind: 'runNodeReconciliation',
        request: foreignRequest,
        reconciliationRound: 1,
        result: { kind: 'effectNotFound' },
      });
    const step = new NodeExecutionStep(executorProvider({ execute, reconcile }));

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect request does not match the expected request.',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects a replayed reconciliation whose round differs', async () => {
    const execute = vi.fn<RunExecutor['execute']>();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>();
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 0,
      })
      .mockResolvedValueOnce({
        kind: 'mustReconcile',
        request,
        storedRecoveryGeneration: 0,
        liveRecoveryGeneration: 1,
      })
      .mockResolvedValueOnce({
        kind: 'runNodeReconciliation',
        request,
        reconciliationRound: 2,
        result: { kind: 'effectNotFound' },
      });
    const step = new NodeExecutionStep(executorProvider({ execute, reconcile }));

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node reconciliation round does not match the expected round.',
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('propagates DBOS workflow cancellation from provider reconciliation', async () => {
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 0,
      })
      .mockImplementation(async (callback) => callback());
    const cancellation = new DBOSError.DBOSWorkflowCancelledError(workflowId);
    const step = new NodeExecutionStep(
      executorProvider({
        execute: vi.fn<RunExecutor['execute']>(),
        reconcile: async () => Promise.reject(cancellation),
      }),
    );

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toBe(cancellation);
  });

  it('checkpoints a typed failed reconciliation round before continuing', async () => {
    const checkpointed: unknown[] = [];
    vi.spyOn(DBOS, 'runStep')
      .mockResolvedValueOnce({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 0,
      })
      .mockImplementation(async (callback) => {
        const result = await callback();
        checkpointed.push(result);
        return result;
      });
    const step = new NodeExecutionStep(
      executorProvider({
        execute: vi.fn<RunExecutor['execute']>(),
        reconcile: async () => Promise.reject(new Error('provider unavailable')),
      }),
    );

    await step.execute(request, 1_000, recovery, 1);

    expect(checkpointed).toContainEqual({
      kind: 'reconciliationFailed',
      request,
      reconciliationRound: 1,
    });
  });

  it('rejects an invalid workflow-status envelope before provider work', async () => {
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(
      Object.assign(workflowStatus(), { createdAt: undefined }),
    );
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const execute = vi.fn<RunExecutor['execute']>();
    const step = new NodeExecutionStep(executorProvider({ execute }));

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'DBOS workflow status envelope is invalid.',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
