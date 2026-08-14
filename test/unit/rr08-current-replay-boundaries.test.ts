import { DBOS, Error as DBOSError, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunExecutor, RunExecutorRequest } from '../../src/contracts/executor/run-executor.js';
import { ScopeCancellationRegistry } from '../../src/dbos/coordination/scope-cancellation-registry.js';
import { ProviderCallRegistry } from '../../src/dbos/executor/provider-call-registry.js';
import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import type { NodeExecutionCoordinator } from '../../src/dbos/steps/node-execution-step.js';
import { NodeExecutionStep } from '../../src/dbos/steps/node-execution-step.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const workflowId = `rr:scope:sc1_${'r'.repeat(43)}`;
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

const workflowStatus = (recoveryAttempts = 0): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  priority: 0,
  recoveryAttempts,
  status: 'PENDING',
  updatedAt: 1,
  workflowClassName: '',
  workflowID: workflowId,
  workflowName: 'revo-run.execution',
});

const intent = (recoveryGeneration = 0) => ({
  kind: 'runNodeEffectIntent' as const,
  request,
  recoveryGeneration,
});

const selection = (
  mode: 'execute' | 'reconcile',
  storedRecoveryGeneration: number,
  liveRecoveryGeneration: number,
) => ({
  kind: 'runNodeEffectSelection' as const,
  request,
  mode,
  storedRecoveryGeneration,
  liveRecoveryGeneration,
});

const decision = (storedRecoveryGeneration = 0, liveRecoveryGeneration = 1) => ({
  kind: 'mustReconcile' as const,
  request,
  storedRecoveryGeneration,
  liveRecoveryGeneration,
});

const reconciliation = (reconciliationRound = 1) => ({
  kind: 'runNodeReconciliation' as const,
  request,
  reconciliationRound,
  result: { kind: 'effectNotFound' as const },
});

const coordinator = (): NodeExecutionCoordinator => ({
  boundary: vi.fn<NodeExecutionCoordinator['boundary']>(async () => undefined),
  reserveExecution: vi.fn<NodeExecutionCoordinator['reserveExecution']>(async () => true),
  executionStarted: vi.fn<NodeExecutionCoordinator['executionStarted']>(async () => undefined),
});

const provider = (executor: RunExecutor): RunExecutorProvider => {
  const value = new RunExecutorProvider();
  value.bind(executor);
  return value;
};

const subject = (executor: RunExecutor): NodeExecutionStep =>
  new NodeExecutionStep(
    provider(executor),
    new ScopeCancellationRegistry(),
    new ProviderCallRegistry(),
    coordinator(),
    1,
  );

const replay = (...values: readonly unknown[]) => {
  const runStep = vi.spyOn(DBOS, 'runStep');
  for (const value of values) {
    runStep.mockResolvedValueOnce(value);
  }
  return runStep;
};

const providerSpies = () => ({
  execute: vi.fn<RunExecutor['execute']>(),
  reconcile: vi.fn<NonNullable<RunExecutor['reconcile']>>(),
});

describe('RR-08 current node-effect replay boundaries', () => {
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

  it.each([
    {
      boundary: 'intent',
      values: [{ ...intent(), unexpected: true }],
      error: 'Stored node effect intent is invalid.',
    },
    {
      boundary: 'selection',
      values: [intent(), { ...selection('execute', 0, 0), unexpected: true }],
      error: 'Stored node effect selection is invalid.',
    },
    {
      boundary: 'decision',
      values: [intent(), selection('execute', 0, 0), { ...decision(), unexpected: true }],
      error: 'Stored node effect decision is invalid.',
    },
    {
      boundary: 'reconciliation',
      values: [intent(), selection('reconcile', 0, 1), { ...reconciliation(), unexpected: true }],
      error: 'Stored node reconciliation is invalid.',
    },
  ])('rejects an additional property at the $boundary checkpoint', async ({ values, error }) => {
    const executor = providerSpies();
    replay(...values);

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(error);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: 'intent',
      values: [{ ...intent(), request: foreignRequest }],
    },
    {
      boundary: 'selection',
      values: [intent(), { ...selection('execute', 0, 0), request: foreignRequest }],
    },
    {
      boundary: 'decision',
      values: [intent(), selection('execute', 0, 0), { ...decision(), request: foreignRequest }],
    },
    {
      boundary: 'reconciliation',
      values: [
        intent(),
        selection('reconcile', 0, 1),
        { ...reconciliation(), request: foreignRequest },
      ],
    },
  ])('rejects a mismatched request at the $boundary checkpoint', async ({ values }) => {
    const executor = providerSpies();
    replay(...values);

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect request does not match the expected request.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'negative intent generation', value: { ...intent(), recoveryGeneration: -1 } },
    { name: 'non-integer intent generation', value: { ...intent(), recoveryGeneration: 0.5 } },
  ])('rejects malformed $name before provider dispatch', async ({ value }) => {
    const executor = providerSpies();
    replay(value);

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect intent is invalid.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'stored generation differs from intent',
      stored: selection('execute', 0, 0),
    },
    { name: 'live generation decreases', stored: selection('reconcile', 1, 0) },
    { name: 'execute mode crosses generations', stored: selection('execute', 1, 2) },
    { name: 'reconcile mode does not cross generations', stored: selection('reconcile', 1, 1) },
  ])('rejects a selection whose $name', async ({ stored }) => {
    const executor = providerSpies();
    replay(intent(1), stored);

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect selection generation is invalid.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it('rejects a live recovery generation that decreases after the intent', async () => {
    const executor = providerSpies();
    vi.spyOn(DBOS, 'getWorkflowStatus')
      .mockResolvedValueOnce(workflowStatus(2))
      .mockResolvedValueOnce(workflowStatus(1));
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Node effect recovery generation decreased.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'stored generation differs from selection',
      stored: decision(0, 2),
    },
    { name: 'live generation equals stored generation', stored: decision(1, 1) },
    { name: 'live generation is below stored generation', stored: decision(2, 1) },
  ])('rejects a decision whose $name', async ({ stored }) => {
    const executor = providerSpies();
    replay(intent(1), selection('execute', 1, 1), stored);

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node effect decision generation is invalid.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it('rejects a reconciliation stored for another round', async () => {
    const executor = providerSpies();
    replay(intent(), selection('reconcile', 0, 1), reconciliation(2));

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'Stored node reconciliation round does not match the expected round.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it('rejects an invalid workflow-status envelope before provider dispatch', async () => {
    const executor = providerSpies();
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(
      Object.assign(workflowStatus(), { createdAt: undefined }),
    );
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toThrow(
      'DBOS workflow status envelope is invalid.',
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).not.toHaveBeenCalled();
  });

  it('checkpoints a timed-out reconciliation as a failed round before retrying', async () => {
    const checkpointed: unknown[] = [];
    const runStep = replay(intent(), selection('reconcile', 0, 1)).mockImplementation(
      async (callback, config) => {
        if (config?.name === 'node-effect-reconcile:1:1:main/root-work') {
          throw new DBOSError.DBOSStepTimeoutError('reconciliation timeout', 1_000);
        }
        const result = await callback();
        checkpointed.push(result);
        return result;
      },
    );
    const executor = providerSpies();
    executor.reconcile.mockResolvedValue({
      kind: 'effectCompleted',
      result: { kind: 'completed', outcome: 'completed' },
    });

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).resolves.toMatchObject({
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
    expect(executor.reconcile).toHaveBeenCalledOnce();
  });

  it('exhausts only after every provider failure has a typed checkpoint', async () => {
    const checkpointed: unknown[] = [];
    replay(intent(), selection('reconcile', 0, 1)).mockImplementation(async (callback) => {
      const result = await callback();
      checkpointed.push(result);
      return result;
    });
    const executor = providerSpies();
    executor.reconcile.mockRejectedValue(new Error('Provider unavailable.'));

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).resolves.toEqual({
      kind: 'recoveryExhausted',
      reconciliationRound: 2,
    });
    expect(checkpointed.filter(isFailedRound)).toEqual([
      { kind: 'reconciliationFailed', request, reconciliationRound: 1 },
      { kind: 'reconciliationFailed', request, reconciliationRound: 2 },
    ]);
    expect(executor.reconcile).toHaveBeenCalledTimes(2);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('propagates DBOS cancellation from provider reconciliation', async () => {
    replay(intent(), selection('reconcile', 0, 1)).mockImplementation(async (callback) =>
      callback(),
    );
    const cancellation = new DBOSError.DBOSWorkflowCancelledError(workflowId);
    const executor = providerSpies();
    executor.reconcile.mockRejectedValue(cancellation);

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).rejects.toBe(cancellation);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.reconcile).toHaveBeenCalledOnce();
  });

  it('disables DBOS retries for every current node-effect step function', async () => {
    const options: { readonly name?: string; readonly retriesAllowed?: boolean }[] = [];
    let invocation = 0;
    const timeout = new DBOSError.DBOSStepTimeoutError('reconciliation timeout', 1_000);
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback, config) => {
      options.push(config ?? {});
      if (config?.name === 'node-effect-reconcile:1:1:main/root-work') {
        throw timeout;
      }
      return callback();
    });
    vi.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async () => {
      invocation += 1;
      return workflowStatus(invocation <= 3 ? 0 : invocation === 4 ? 0 : 1);
    });
    const executor = providerSpies();
    executor.execute.mockResolvedValue({ kind: 'completed', outcome: 'completed' });

    await expect(subject(executor).execute(request, 1_000, recovery, 1)).resolves.toMatchObject({
      kind: 'effectResult',
    });
    await expect(
      subject(executor).execute(request, 1_000, { ...recovery, maximumAttempts: 1 }, 1),
    ).resolves.toEqual({ kind: 'recoveryExhausted', reconciliationRound: 1 });

    expect(new Set(options.map(({ name }) => name))).toEqual(
      new Set([
        'node-effect-intent:1:main/root-work',
        'node-effect-selection:1:main/root-work',
        'node-effect-decision:1:main/root-work',
        'node-effect-reconcile:1:1:main/root-work',
        'node-effect-reconcile-failed:1:1:main/root-work',
        'node-effect-reconcile-outcome:1:1:main/root-work',
      ]),
    );
    expect(options.every(({ retriesAllowed }) => retriesAllowed === false)).toBe(true);
  });
});

const isFailedRound = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'kind' in value &&
  value.kind === 'reconciliationFailed';
