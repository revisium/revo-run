import { DBOS, Error as DBOSError, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunExecutorReconciliationResult } from '../../src/contracts/executor/run-executor.js';
import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import { NodeExecutionStep } from '../../src/dbos/steps/node-execution-step.js';
import type { RunExecutor } from '../../src/index.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const workflowId = `rr:scope:v1:${'b'.repeat(43)}`;
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
  recoveryAttempts: 1,
  status: 'PENDING',
  updatedAt: 1,
  workflowClassName: '',
  workflowID: workflowId,
  workflowName: 'revo-run.execution.v1',
});

const provider = (executor: RunExecutor): RunExecutorProvider => {
  const value = new RunExecutorProvider();
  value.bind(executor);
  return value;
};

const replayAmbiguousIntent = () =>
  vi
    .spyOn(DBOS, 'runStep')
    .mockResolvedValueOnce({ kind: 'runNodeEffectIntent', request, recoveryGeneration: 0 })
    .mockImplementation(async (callback) => callback());

describe('node reconciliation state machine', () => {
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

  it('executes the initial generation and checkpoints its result', async () => {
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const execute = vi.fn<RunExecutor['execute']>(async () => ({
      kind: 'completed',
      outcome: 'completed',
    }));
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>();
    const step = new NodeExecutionStep(provider({ execute, reconcile }));

    await expect(step.execute(request, 1_000, recovery, 1)).resolves.toMatchObject({
      kind: 'effectResult',
      execution: { result: { kind: 'completed', outcome: 'completed' } },
      nextReconciliationRound: 1,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each<{
    expected: object;
    result: RunExecutorReconciliationResult;
  }>([
    {
      result: {
        kind: 'effectCompleted',
        result: {
          kind: 'completed',
          outcome: 'completed',
          output: { result: { kind: 'json', value: { adopted: true } } },
        },
      },
      expected: {
        kind: 'effectResult',
        execution: { result: { kind: 'completed', outcome: 'completed' } },
        nextReconciliationRound: 2,
      },
    },
    {
      result: {
        kind: 'effectFailed',
        error: { code: 'provider_failed', message: 'Provider rejected the effect.' },
      },
      expected: {
        kind: 'effectResult',
        execution: { result: { kind: 'failed', error: { code: 'provider_failed' } } },
        nextReconciliationRound: 2,
      },
    },
    {
      result: { kind: 'effectNotFound' },
      expected: { kind: 'effectNotFound', nextReconciliationRound: 2 },
    },
    {
      result: { kind: 'outcomeUnknown' },
      expected: { kind: 'outcomeUnknown', reconciliationRound: 1 },
    },
  ])('routes $result.kind without repeating execute', async ({ result, expected }) => {
    replayAmbiguousIntent();
    const execute = vi.fn<RunExecutor['execute']>();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () => result);
    const step = new NodeExecutionStep(provider({ execute, reconcile }));

    await expect(step.execute(request, 1_000, recovery, 1)).resolves.toMatchObject(expected);
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
    const reconciliationCall = reconcile.mock.calls[0];
    expect(reconciliationCall?.[0]).toEqual(request);
    expect(reconciliationCall?.[1]).toBe(request.attemptId);
    expect(reconciliationCall?.[2].signal).toBeInstanceOf(AbortSignal);
  });

  it('fails an unsupported ambiguous effect without provider work', async () => {
    const runStep = replayAmbiguousIntent();
    const execute = vi.fn<RunExecutor['execute']>();
    const step = new NodeExecutionStep(provider({ execute }));

    await expect(
      step.execute(request, 1_000, { reconciliation: 'unsupported', unknownOutcome: 'fail' }, 1),
    ).resolves.toEqual({ kind: 'outcomeUnknown', reconciliationRound: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(runStep.mock.calls.at(-1)?.[1]).toMatchObject({
      name: 'node-effect-reconcile-outcome:1:1:main/root-work',
      retriesAllowed: false,
    });
  });

  it('rejects an extended replayed reconciliation before continuation', async () => {
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
        reconciliationRound: 1,
        result: { kind: 'effectNotFound', retry: true },
      });
    const step = new NodeExecutionStep(provider({ execute, reconcile }));

    await expect(step.execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node reconciliation is invalid.',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('exhausts only after every failed round has a typed durable result', async () => {
    const records: unknown[] = [];
    const runStep = replayAmbiguousIntent().mockImplementation(async (callback) => {
      const result = await callback();
      records.push(result);
      return result;
    });
    const execute = vi.fn<RunExecutor['execute']>();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () =>
      Promise.reject(new Error('Provider unavailable.')),
    );
    const step = new NodeExecutionStep(provider({ execute, reconcile }));

    await expect(step.execute(request, 1_000, recovery, 1)).resolves.toEqual({
      kind: 'recoveryExhausted',
      reconciliationRound: 2,
    });
    expect(records.filter(isFailedRound)).toEqual([
      { kind: 'reconciliationFailed', request, reconciliationRound: 1 },
      { kind: 'reconciliationFailed', request, reconciliationRound: 2 },
    ]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(runStep.mock.calls.at(-1)?.[1]).toMatchObject({
      name: 'node-effect-reconcile-outcome:1:2:main/root-work',
    });
  });

  it('checkpoints a DBOS timeout as a failed round before retrying', async () => {
    const checkpointed: unknown[] = [];
    const runStep = replayAmbiguousIntent().mockImplementation(async (callback, config) => {
      if (config?.name === 'node-effect-reconcile:1:1:main/root-work') {
        throw new DBOSError.DBOSStepTimeoutError('reconciliation timeout', 1_000);
      }
      const result = await callback();
      checkpointed.push(result);
      return result;
    });
    const execute = vi.fn<RunExecutor['execute']>();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () => ({
      kind: 'effectCompleted',
      result: { kind: 'completed', outcome: 'completed' },
    }));
    const step = new NodeExecutionStep(provider({ execute, reconcile }));

    await expect(step.execute(request, 1_000, recovery, 1)).resolves.toMatchObject({
      kind: 'effectResult',
      nextReconciliationRound: 3,
    });
    expect(checkpointed).toContainEqual({
      kind: 'reconciliationFailed',
      request,
      reconciliationRound: 1,
    });
    expect(runStep.mock.calls.map(([, config]) => config?.name)).toContain(
      'node-effect-reconcile-failed:1:1:main/root-work',
    );
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('checkpoints an invalid provider response as a failed round', async () => {
    const records: unknown[] = [];
    replayAmbiguousIntent().mockImplementation(async (callback) => {
      const result = await callback();
      records.push(result);
      return result;
    });
    const invalidResult = Object.assign({ kind: 'effectNotFound' as const }, { retry: true });
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () => invalidResult);
    const step = new NodeExecutionStep(
      provider({ execute: vi.fn<RunExecutor['execute']>(), reconcile }),
    );

    await step.execute(request, 1_000, { ...recovery, maximumAttempts: 1 }, 1);

    expect(records).toContainEqual({
      kind: 'reconciliationFailed',
      request,
      reconciliationRound: 1,
    });
  });
});

const isFailedRound = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'kind' in value &&
  value.kind === 'reconciliationFailed';
