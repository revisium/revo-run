import assert from 'node:assert/strict';

import { vi } from 'vitest';

import type {
  ExecutorInput,
  AttemptId,
  JsonValue,
  RunExecutor,
  RunExecutorRequest,
  RunExecutorReconciliationResult,
  RunExecutorResult,
} from '../../../src/index.js';

interface PendingExecution {
  readonly request: RunExecutorRequest;
  readonly resolve: (result: RunExecutorResult) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingReconciliation {
  readonly request: RunExecutorRequest;
  readonly resolve: (result: RunExecutorReconciliationResult) => void;
}

const visibleInput = (input: ExecutorInput): JsonValue =>
  Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.kind === 'json' ? value.value : value]),
  );

export class ControlledRunExecutor implements RunExecutor {
  private readonly pending = new Map<string, PendingExecution[]>();
  private readonly pendingReconciliations = new Map<string, PendingReconciliation[]>();
  private readonly requests: RunExecutorRequest[] = [];
  private readonly externalEffects = new Map<string, number>();
  private readonly resolvedSecrets = new Set<string>();
  private maximumActiveExecutions = 0;
  private readonly abortedPaths = new Set<string>();
  private readonly ignoredAbortPaths = new Set<string>();

  execute(
    request: RunExecutorRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<RunExecutorResult> {
    this.requests.push(request);
    return new Promise((resolve, reject) => {
      const pending = this.pending.get(request.displayPath) ?? [];
      const execution = { request, resolve, reject };
      pending.push(execution);
      this.pending.set(request.displayPath, pending);
      this.maximumActiveExecutions = Math.max(
        this.maximumActiveExecutions,
        this.activeExecutions(),
      );
      context.signal.addEventListener(
        'abort',
        () => {
          this.abortedPaths.add(request.displayPath);
          if (this.ignoredAbortPaths.has(request.displayPath)) {
            return;
          }
          const current = this.pending.get(request.displayPath);
          const index = current?.indexOf(execution) ?? -1;
          if (index >= 0) {
            current?.splice(index, 1);
          }
          reject(context.signal.reason);
        },
        { once: true },
      );
    });
  }

  reconcile(
    request: RunExecutorRequest,
    _attemptId: AttemptId,
  ): Promise<RunExecutorReconciliationResult> {
    return new Promise((resolve) => {
      const pending = this.pendingReconciliations.get(request.displayPath) ?? [];
      pending.push({ request, resolve });
      this.pendingReconciliations.set(request.displayPath, pending);
    });
  }

  async reconcileNode(path: string, result: RunExecutorReconciliationResult): Promise<void> {
    await vi.waitFor(() => {
      assert((this.pendingReconciliations.get(path)?.length ?? 0) > 0);
    });
    const pending = this.pendingReconciliations.get(path)?.shift();
    if (pending === undefined) {
      throw new Error(`Reconciliation ${path} was not requested.`);
    }
    pending.resolve(result);
  }

  async expectAborted(path: string): Promise<void> {
    await vi.waitFor(() => assert(this.abortedPaths.has(path)), { timeout: 5_000 });
  }

  ignoreAbort(path: string): void {
    this.ignoredAbortPaths.add(path);
  }

  async attemptId(path: string, ordinal = 1): Promise<string> {
    await this.expectStarted(path);
    const request = this.requests.find(
      (candidate) => candidate.displayPath === path && candidate.attemptOrdinal === ordinal,
    );
    assert(request !== undefined);
    return request.attemptId;
  }

  async complete(
    path: string,
    result: Extract<RunExecutorResult, { readonly kind: 'completed' }>,
    attemptOrdinal = 1,
  ): Promise<void> {
    const execution = await this.takeAttempt(path, attemptOrdinal);
    this.resolveSecrets(execution.request.input);
    this.recordExternalEffect(path);
    execution.resolve(result);
  }

  async completeLatest(
    path: string,
    result: Extract<RunExecutorResult, { readonly kind: 'completed' }>,
  ): Promise<void> {
    const execution = await this.takeLatest(path);
    this.resolveSecrets(execution.request.input);
    this.recordExternalEffect(path);
    execution.resolve(result);
  }

  async fail(path: string, errorCode: string, attemptOrdinal = 1): Promise<void> {
    const execution = await this.takeAttempt(path, attemptOrdinal);
    this.recordExternalEffect(path);
    execution.resolve({
      kind: 'failed',
      error: { code: errorCode, message: `Execution failed with ${errorCode}.` },
    });
  }

  async failInputResolution(path: string, errorCode: string): Promise<void> {
    const execution = await this.takeAttempt(path, 1);
    execution.resolve({
      kind: 'inputResolutionFailed',
      error: { code: errorCode, message: `Input resolution failed with ${errorCode}.` },
    });
  }

  async expectStarted(path: string): Promise<void> {
    await vi.waitFor(
      () => {
        assert(
          this.requests.some((request) => request.displayPath === path),
          `Execution ${path} was not dispatched.`,
        );
      },
      { timeout: 5_000 },
    );
  }

  async expectAgentExecution(path: string, roleId: string): Promise<void> {
    const request = await this.requestAt(path);
    assert.equal(request.binding.kind, 'agent');
    assert.equal(request.binding.roleId, roleId);
  }

  async expectVersionedScriptExecution(
    path: string,
    scriptId: string,
    revision: number,
  ): Promise<void> {
    const request = await this.requestAt(path);
    assert.equal(request.binding.kind, 'script');
    assert.deepStrictEqual(request.binding.script, { id: scriptId, revision });
  }

  async expectInput(path: string, expected: JsonValue): Promise<void> {
    const request = await this.requestAt(path);
    assert.deepStrictEqual(visibleInput(request.input), expected);
  }

  expectNoExternalEffect(path: string): void {
    assert.equal(this.externalEffects.get(path) ?? 0, 0);
  }

  expectNotDispatched(path: string): void {
    assert.equal(this.executionCount(path), 0);
  }

  expectResolvedSecret(value: string): void {
    assert(this.resolvedSecrets.has(value));
  }

  executionCount(path: string): number {
    return this.requests.filter((request) => request.displayPath === path).length;
  }

  async expectExecutionCount(path: string, count: number): Promise<void> {
    await vi.waitFor(() => {
      assert.equal(this.executionCount(path), count);
    });
  }

  async expectMaximumActiveExecutions(count: number): Promise<void> {
    await vi.waitFor(
      () => {
        assert.equal(this.activeExecutions(), count);
      },
      { timeout: 5_000 },
    );
    assert.equal(this.maximumActiveExecutions, count);
  }

  private activeExecutions(): number {
    return [...this.pending.values()].reduce((count, pending) => count + pending.length, 0);
  }

  private async requestAt(path: string): Promise<RunExecutorRequest> {
    await this.expectStarted(path);
    const request = this.requests.findLast((candidate) => candidate.displayPath === path);
    assert(request !== undefined);
    return request;
  }

  private async takeAttempt(path: string, attemptOrdinal: number): Promise<PendingExecution> {
    await vi.waitFor(() => {
      assert(
        this.pending.get(path)?.some(({ request }) => request.attemptOrdinal === attemptOrdinal),
      );
    });

    const pending = this.pending.get(path);
    const executionIndex = pending?.findIndex(
      ({ request }) => request.attemptOrdinal === attemptOrdinal,
    );
    const execution =
      executionIndex === undefined ? undefined : pending?.splice(executionIndex, 1)[0];
    if (execution === undefined) {
      throw new Error(`Execution ${path} attempt ${attemptOrdinal} was not started.`);
    }
    return execution;
  }

  private async takeLatest(path: string): Promise<PendingExecution> {
    await vi.waitFor(() => {
      assert((this.pending.get(path)?.length ?? 0) > 0);
    });

    const execution = this.pending.get(path)?.pop();
    if (execution === undefined) {
      throw new Error(`Execution ${path} was not started.`);
    }
    return execution;
  }

  private recordExternalEffect(path: string): void {
    this.externalEffects.set(path, (this.externalEffects.get(path) ?? 0) + 1);
  }

  private resolveSecrets(input: ExecutorInput): void {
    for (const value of Object.values(input)) {
      if (value.kind === 'secret') {
        this.resolvedSecrets.add(`resolved-${value.reference.name}`);
      }
    }
  }
}
