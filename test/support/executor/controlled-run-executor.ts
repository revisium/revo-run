import assert from 'node:assert/strict';

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
  readonly tryClaim: () => boolean;
  readonly resolve: (result: RunExecutorResult) => void;
}

interface PendingReconciliation {
  readonly request: RunExecutorRequest;
  readonly resolve: (result: RunExecutorReconciliationResult) => void;
}

interface ObservationChange {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const executorObservationTimeoutMs = 10_000;

const createObservationChange = (): ObservationChange => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((createdResolve) => {
    resolve = createdResolve;
  });
  return { promise, resolve };
};

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
  private observationChange = createObservationChange();

  execute(
    request: RunExecutorRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<RunExecutorResult> {
    this.requests.push(request);
    return new Promise((resolve, reject) => {
      const pending = this.pending.get(request.displayPath) ?? [];
      let state: 'pending' | 'claimed' | 'settled' = 'pending';
      let abort = (): void => undefined;
      let abortListenerRegistered = false;
      let abortObserved = false;
      const removeAbortListener = (): void => {
        if (!abortListenerRegistered) {
          return;
        }
        abortListenerRegistered = false;
        context.signal.removeEventListener('abort', abort);
      };
      const execution: PendingExecution = {
        request,
        tryClaim: () => {
          if (state !== 'pending') {
            return false;
          }
          state = 'claimed';
          return true;
        },
        resolve: (result) => {
          assert.equal(state, 'claimed');
          state = 'settled';
          removeAbortListener();
          resolve(result);
        },
      };
      pending.push(execution);
      this.pending.set(request.displayPath, pending);
      this.maximumActiveExecutions = Math.max(
        this.maximumActiveExecutions,
        this.activeExecutions(),
      );
      this.signalObservationChange();
      abort = () => {
        if (abortObserved) {
          return;
        }
        abortObserved = true;
        removeAbortListener();
        this.abortedPaths.add(request.displayPath);
        if (this.ignoredAbortPaths.has(request.displayPath) || state !== 'pending') {
          this.signalObservationChange();
          return;
        }

        state = 'settled';
        const current = this.pending.get(request.displayPath);
        const index = current?.indexOf(execution) ?? -1;
        if (index >= 0) {
          current?.splice(index, 1);
        }
        this.signalObservationChange();
        reject(context.signal.reason);
      };
      abortListenerRegistered = true;
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) {
        abort();
      }
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
      this.signalObservationChange();
    });
  }

  async reconcileNode(path: string, result: RunExecutorReconciliationResult): Promise<void> {
    const pending = await this.waitForObservation(
      () => {
        const reconciliation = this.pendingReconciliations.get(path)?.shift();
        if (reconciliation !== undefined) {
          this.signalObservationChange();
        }
        return reconciliation;
      },
      () => `Reconciliation ${path} was not requested`,
    );
    pending.resolve(result);
  }

  async expectAborted(path: string): Promise<void> {
    await this.waitForCondition(
      () => this.abortedPaths.has(path),
      () => `Execution ${path} was not aborted`,
    );
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
    await this.waitForCondition(
      () => this.requests.some((request) => request.displayPath === path),
      () => `Execution ${path} was not dispatched`,
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
    await this.waitForCondition(
      () => this.executionCount(path) === count,
      () =>
        `Expected ${String(count)} execution(s) for ${path}, observed ${String(this.executionCount(path))}`,
    );
  }

  async expectMaximumActiveExecutions(count: number): Promise<void> {
    await this.waitForCondition(
      () => this.activeExecutions() === count,
      () =>
        `Expected ${String(count)} active execution(s), observed ${String(this.activeExecutions())}`,
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
    return this.waitForObservation(
      () => {
        const pending = this.pending.get(path);
        const executionIndex = pending?.findIndex(
          ({ request }) => request.attemptOrdinal === attemptOrdinal,
        );
        if (pending === undefined || executionIndex === undefined || executionIndex < 0) {
          return undefined;
        }

        const execution = pending[executionIndex];
        if (execution === undefined || !execution.tryClaim()) {
          return undefined;
        }
        pending.splice(executionIndex, 1);
        this.signalObservationChange();
        return execution;
      },
      () => `Execution ${path} attempt ${String(attemptOrdinal)} was not started`,
    );
  }

  private async takeLatest(path: string): Promise<PendingExecution> {
    return this.waitForObservation(
      () => {
        const pending = this.pending.get(path);
        const execution = pending?.at(-1);
        if (execution === undefined || !execution.tryClaim()) {
          return undefined;
        }
        pending?.pop();
        this.signalObservationChange();
        return execution;
      },
      () => `Execution ${path} was not started`,
    );
  }

  private async waitForCondition(
    condition: () => boolean,
    failureMessage: () => string,
  ): Promise<void> {
    await this.waitForObservation(() => (condition() ? true : undefined), failureMessage);
  }

  private async waitForObservation<T>(
    observe: () => T | undefined,
    failureMessage: () => string,
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`${failureMessage()} within ${String(executorObservationTimeoutMs)} ms.`));
      }, executorObservationTimeoutMs);
    });
    const wait = async (): Promise<T> => {
      const observation = observe();
      if (observation !== undefined) {
        return observation;
      }

      const observationChange = this.observationChange.promise;
      // Close the race where state changes while the current signal is being captured.
      const observationAfterSignalCapture = observe();
      if (observationAfterSignalCapture !== undefined) {
        return observationAfterSignalCapture;
      }
      await Promise.race([observationChange, timeout]);
      return wait();
    };

    try {
      return await wait();
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private signalObservationChange(): void {
    const observationChange = this.observationChange;
    this.observationChange = createObservationChange();
    observationChange.resolve();
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
