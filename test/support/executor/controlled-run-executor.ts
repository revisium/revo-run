import assert from 'node:assert/strict';

import { vi } from 'vitest';

import type {
  ExecutorInput,
  JsonValue,
  RunExecutor,
  RunExecutorRequest,
  RunExecutorResult,
} from '../../../src/index.js';

interface PendingExecution {
  readonly request: RunExecutorRequest;
  readonly resolve: (result: RunExecutorResult) => void;
}

const visibleInput = (input: ExecutorInput): JsonValue =>
  Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.kind === 'json' ? value.value : value]),
  );

export class ControlledRunExecutor implements RunExecutor {
  private readonly pending = new Map<string, PendingExecution[]>();
  private readonly requests: RunExecutorRequest[] = [];
  private readonly externalEffects = new Map<string, number>();
  private readonly resolvedSecrets = new Set<string>();
  private maximumActiveExecutions = 0;

  execute(request: RunExecutorRequest): Promise<RunExecutorResult> {
    this.requests.push(request);
    return new Promise((resolve) => {
      const pending = this.pending.get(request.displayPath) ?? [];
      pending.push({ request, resolve });
      this.pending.set(request.displayPath, pending);
      this.maximumActiveExecutions = Math.max(
        this.maximumActiveExecutions,
        this.activeExecutions(),
      );
    });
  }

  async complete(
    path: string,
    result: Extract<RunExecutorResult, { readonly kind: 'completed' }>,
  ): Promise<void> {
    const execution = await this.take(path);
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

  async fail(path: string, errorCode: string): Promise<void> {
    const execution = await this.take(path);
    this.recordExternalEffect(path);
    execution.resolve({
      kind: 'failed',
      error: { code: errorCode, message: `Execution failed with ${errorCode}.` },
    });
  }

  async failInputResolution(path: string, errorCode: string): Promise<void> {
    const execution = await this.take(path);
    execution.resolve({
      kind: 'inputResolutionFailed',
      error: { code: errorCode, message: `Input resolution failed with ${errorCode}.` },
    });
  }

  async expectStarted(path: string): Promise<void> {
    await vi.waitFor(
      () => {
        assert(this.requests.some((request) => request.displayPath === path));
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

  private async take(path: string): Promise<PendingExecution> {
    await vi.waitFor(() => {
      assert((this.pending.get(path)?.length ?? 0) > 0);
    });

    const pending = this.pending.get(path);
    const execution = pending?.shift();
    if (execution === undefined) {
      throw new Error(`Execution ${path} was not started.`);
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
