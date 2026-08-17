import { DBOS, Error as DBOSError, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunExecutor } from '../../src/contracts/executor/run-executor.js';
import { ScopeCancellationRegistry } from '../../src/dbos/coordination/scope-cancellation-registry.js';
import { ProviderCallRegistry } from '../../src/dbos/executor/provider-call-registry.js';
import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import type { NodeExecutionCoordinator } from '../../src/dbos/steps/node-execution-step.js';
import { NodeExecutionStep } from '../../src/dbos/steps/node-execution-step.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const workflowId = `rr:scope:sc1_${'b'.repeat(43)}`;
const request = storedNodeExecution('main/root-work', 'completed').request;
const recovery = {
  reconciliation: 'required',
  maximumAttempts: 1,
  timeoutMs: 1_000,
  unknownOutcome: 'fail',
} as const;

const status = (recoveryAttempts: number): WorkflowStatus => ({
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

const deferred = <Value>() => {
  let resolve: ((value: Value) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return {
    promise,
    resolve(value: Value): void {
      if (resolve === undefined) {
        throw new Error('Deferred promise has no resolver.');
      }
      resolve(value);
    },
    reject(error: unknown): void {
      if (reject === undefined) {
        throw new Error('Deferred promise has no rejector.');
      }
      reject(error);
    },
  };
};

const provider = (executor: RunExecutor): RunExecutorProvider => {
  const result = new RunExecutorProvider();
  result.bind(executor);
  return result;
};

const coordinator = (): NodeExecutionCoordinator => ({
  boundary: vi.fn<NodeExecutionCoordinator['boundary']>(async () => undefined),
  reserveExecution: vi.fn<NodeExecutionCoordinator['reserveExecution']>(async () => true),
  executionStarted: vi.fn<NodeExecutionCoordinator['executionStarted']>(async () => undefined),
});

describe('provider boundaries', () => {
  beforeEach(() => {
    vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(workflowId);
    vi.spyOn(DBOS, 'stepStatus', 'get').mockReturnValue({
      stepID: 1,
      timeoutSignal: new AbortController().signal,
    });
    vi.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue(status(0));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retains execute capacity until an abandoned abort-ignoring provider promise settles', async () => {
    let timeout = new AbortController();
    vi.spyOn(DBOS, 'stepStatus', 'get').mockImplementation(() => ({
      stepID: 1,
      timeoutSignal: timeout.signal,
    }));
    const calls: ReturnType<typeof deferred<Awaited<ReturnType<RunExecutor['execute']>>>>[] = [];
    let active = 0;
    let maximumActive = 0;
    const execute = vi.fn<RunExecutor['execute']>(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const call = deferred<Awaited<ReturnType<RunExecutor['execute']>>>();
      calls.push(call);
      return call.promise.finally(() => {
        active -= 1;
      });
    });
    let decisionOrdinal = 0;
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback, config) => {
      if (config?.name?.startsWith('node-effect-decision:') === true) {
        decisionOrdinal += 1;
        if (decisionOrdinal === 1) {
          void callback();
          await vi.waitUntil(() => execute.mock.calls.length === 1);
          const error = new DBOSError.DBOSStepTimeoutError('provider timeout', 1_000);
          timeout.abort(error);
          throw error;
        }
      }
      return callback();
    });
    const step = new NodeExecutionStep(
      provider({ execute }),
      new ScopeCancellationRegistry(),
      new ProviderCallRegistry(),
      coordinator(),
      1,
    );

    await expect(step.execute(request, 1_000, recovery, 1)).resolves.toEqual({
      kind: 'timedOut',
    });
    timeout = new AbortController();
    const second = step.execute(request, 1_000, recovery, 1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(active).toBe(1);

    calls[0]?.resolve({ kind: 'completed', outcome: 'late' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
    calls[1]?.resolve({ kind: 'completed', outcome: 'completed' });
    await expect(second).resolves.toMatchObject({ kind: 'effectResult' });
  });

  it('retains reconcile capacity until an abandoned abort-ignoring provider promise settles', async () => {
    let generationRead = 0;
    vi.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async () => {
      generationRead += 1;
      return status(generationRead % 2 === 1 ? 0 : 1);
    });
    let timeout = new AbortController();
    vi.spyOn(DBOS, 'stepStatus', 'get').mockImplementation(() => ({
      stepID: 1,
      timeoutSignal: timeout.signal,
    }));
    const calls: ReturnType<
      typeof deferred<Awaited<ReturnType<NonNullable<RunExecutor['reconcile']>>>>
    >[] = [];
    let active = 0;
    let maximumActive = 0;
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const call = deferred<Awaited<ReturnType<NonNullable<RunExecutor['reconcile']>>>>();
      calls.push(call);
      return call.promise.finally(() => {
        active -= 1;
      });
    });
    let reconciliationOrdinal = 0;
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback, config) => {
      if (config?.name?.startsWith('node-effect-reconcile:') === true) {
        reconciliationOrdinal += 1;
        if (reconciliationOrdinal === 1) {
          void callback();
          await vi.waitUntil(() => reconcile.mock.calls.length === 1);
          const error = new DBOSError.DBOSStepTimeoutError('reconciliation timeout', 1_000);
          timeout.abort(error);
          throw error;
        }
      }
      return callback();
    });
    const step = new NodeExecutionStep(
      provider({ execute: vi.fn<RunExecutor['execute']>(), reconcile }),
      new ScopeCancellationRegistry(),
      new ProviderCallRegistry(),
      coordinator(),
      1,
    );

    await expect(step.execute(request, 1_000, recovery, 1)).resolves.toEqual({
      kind: 'recoveryExhausted',
      reconciliationRound: 1,
    });
    timeout = new AbortController();
    const second = step.execute(request, 1_000, recovery, 1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    expect(active).toBe(1);

    calls[0]?.resolve({ kind: 'effectNotFound' });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
    calls[1]?.resolve({ kind: 'effectCompleted', result: { kind: 'completed', outcome: 'done' } });
    await expect(second).resolves.toMatchObject({ kind: 'effectResult' });
  });

  it('does not reserve cumulative budget or start an attempt when a queued call is cancelled', async () => {
    const runStep = vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const cancellation = new ScopeCancellationRegistry();
    const registry = new ProviderCallRegistry();
    const blocker = await registry.acquire(request.runId, 1, new AbortController().signal);
    const coordination = coordinator();
    const execute = vi.fn<RunExecutor['execute']>();
    const step = new NodeExecutionStep(
      provider({ execute }),
      cancellation,
      registry,
      coordination,
      1,
    );

    const result = step.execute(request, 1_000, recovery, 1);
    await vi.waitFor(() => expect(runStep).toHaveBeenCalledTimes(2));
    cancellation.cancelScope(request.scopeId);

    await expect(result).resolves.toEqual({ kind: 'cancelled' });
    const { reserveExecution, executionStarted } = coordination;
    expect(reserveExecution).not.toHaveBeenCalled();
    expect(executionStarted).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    blocker.release();
  });

  it('does not reserve cumulative budget or start an attempt when a queued call times out', async () => {
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const registry = new ProviderCallRegistry();
    const blocker = await registry.acquire(request.runId, 1, new AbortController().signal);
    const coordination = coordinator();
    const execute = vi.fn<RunExecutor['execute']>();
    const step = new NodeExecutionStep(
      provider({ execute }),
      new ScopeCancellationRegistry(),
      registry,
      coordination,
      1,
    );

    await expect(step.execute(request, 10, recovery, 1)).resolves.toEqual({ kind: 'timedOut' });
    const { reserveExecution, executionStarted } = coordination;
    expect(reserveExecution).not.toHaveBeenCalled();
    expect(executionStarted).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    blocker.release();
  });

  it('persists cancellation when execute resolves successfully after ignoring abort', async () => {
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const call = deferred<Awaited<ReturnType<RunExecutor['execute']>>>();
    const cancellation = new ScopeCancellationRegistry();
    const execute = vi.fn<RunExecutor['execute']>(async () => call.promise);
    const step = new NodeExecutionStep(
      provider({ execute }),
      cancellation,
      new ProviderCallRegistry(),
      coordinator(),
      1,
    );

    const result = step.execute(request, 1_000, recovery, 1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    cancellation.cancelScope(request.scopeId);
    call.resolve({ kind: 'completed', outcome: 'too-late' });

    await expect(result).resolves.toEqual({ kind: 'cancelled' });
  });

  it('persists cancellation when reconcile resolves successfully after ignoring abort', async () => {
    let generationRead = 0;
    vi.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async () => {
      generationRead += 1;
      return status(generationRead === 1 ? 0 : 1);
    });
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const call = deferred<Awaited<ReturnType<NonNullable<RunExecutor['reconcile']>>>>();
    const cancellation = new ScopeCancellationRegistry();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () => call.promise);
    const step = new NodeExecutionStep(
      provider({ execute: vi.fn<RunExecutor['execute']>(), reconcile }),
      cancellation,
      new ProviderCallRegistry(),
      coordinator(),
      1,
    );

    const result = step.execute(request, 1_000, recovery, 1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    cancellation.cancelScope(request.scopeId);
    call.resolve({
      kind: 'effectCompleted',
      result: { kind: 'completed', outcome: 'too-late' },
    });

    await expect(result).resolves.toEqual({ kind: 'cancelled' });
  });

  it('persists cancellation when execute rejects with a provider-owned error after abort', async () => {
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const call = deferred<Awaited<ReturnType<RunExecutor['execute']>>>();
    const cancellation = new ScopeCancellationRegistry();
    const execute = vi.fn<RunExecutor['execute']>(async () => call.promise);
    const step = new NodeExecutionStep(
      provider({ execute }),
      cancellation,
      new ProviderCallRegistry(),
      coordinator(),
      1,
    );

    const result = step.execute(request, 1_000, recovery, 1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    cancellation.cancelScope(request.scopeId);
    call.reject(new Error('provider rejected after cancellation'));

    await expect(result).resolves.toEqual({ kind: 'cancelled' });
  });

  it('persists cancellation when reconcile rejects with a provider-owned error after abort', async () => {
    let generationRead = 0;
    vi.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async () => {
      generationRead += 1;
      return status(generationRead === 1 ? 0 : 1);
    });
    vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
    const call = deferred<Awaited<ReturnType<NonNullable<RunExecutor['reconcile']>>>>();
    const cancellation = new ScopeCancellationRegistry();
    const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () => call.promise);
    const step = new NodeExecutionStep(
      provider({ execute: vi.fn<RunExecutor['execute']>(), reconcile }),
      cancellation,
      new ProviderCallRegistry(),
      coordinator(),
      1,
    );

    const result = step.execute(request, 1_000, recovery, 1);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    cancellation.cancelScope(request.scopeId);
    call.reject(new Error('reconcile rejected after cancellation'));

    await expect(result).resolves.toEqual({ kind: 'cancelled' });
  });
});
