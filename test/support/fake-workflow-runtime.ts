import type { JsonValue } from '@revisium/revo-pipeline';

import type { ExecutionPlan, RunSnapshot } from '../../src/types.js';
import type { WorkflowRuntime } from '../../src/workflow/create-workflow-runtime.js';

const deferred = <Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

export class FakeWorkflowRuntime implements WorkflowRuntime {
  private configureCallCount = 0;
  private disposeCallCount = 0;
  private getGate: ReturnType<typeof deferred<RunSnapshot | undefined>> | undefined;
  private getPending = false;
  private launchCallCount = 0;
  private launchFailure: Error | undefined;
  private shutdownCallCount = 0;
  private shutdownFailure: Error | undefined;
  private shutdownGate: ReturnType<typeof deferred<void>> | undefined;
  private submitGate: ReturnType<typeof deferred<void>> | undefined;
  private submitPending = false;

  configure(): void {
    this.configureCallCount += 1;
  }

  dispose(): void {
    this.disposeCallCount += 1;
  }

  async launch(): Promise<void> {
    this.launchCallCount += 1;
    if (this.launchFailure) {
      const error = this.launchFailure;
      this.launchFailure = undefined;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownCallCount += 1;
    if (this.shutdownFailure) {
      const error = this.shutdownFailure;
      this.shutdownFailure = undefined;
      throw error;
    }
    await this.shutdownGate?.promise;
  }

  async submit(_runId: string, _executionPlan: ExecutionPlan, _input: JsonValue): Promise<void> {
    this.submitPending = true;
    try {
      await this.submitGate?.promise;
    } finally {
      this.submitPending = false;
    }
  }

  async get(_runId: string): Promise<RunSnapshot | undefined> {
    this.getPending = true;
    try {
      return await this.getGate?.promise;
    } finally {
      this.getPending = false;
    }
  }

  failNextLaunch(error = new Error('launch failed')): void {
    this.launchFailure = error;
  }

  failNextShutdown(error = new Error('shutdown failed')): void {
    this.shutdownFailure = error;
  }

  deferShutdown(): void {
    this.shutdownGate = deferred<void>();
  }

  completeShutdown(): void {
    this.shutdownGate?.resolve();
    this.shutdownGate = undefined;
  }

  deferSubmit(): void {
    this.submitGate = deferred<void>();
  }

  completeSubmit(): void {
    this.submitGate?.resolve();
    this.submitGate = undefined;
  }

  hasPendingSubmit(): boolean {
    return this.submitPending;
  }

  deferGet(): void {
    this.getGate = deferred<RunSnapshot | undefined>();
  }

  completeGet(snapshot: RunSnapshot | undefined): void {
    this.getGate?.resolve(snapshot);
    this.getGate = undefined;
  }

  isGetPending(): boolean {
    return this.getPending;
  }

  configureCalls(): number {
    return this.configureCallCount;
  }

  disposeCalls(): number {
    return this.disposeCallCount;
  }

  launchCalls(): number {
    return this.launchCallCount;
  }

  shutdownCalls(): number {
    return this.shutdownCallCount;
  }
}

export class FakeProcessManagerOwnership {
  private releaseCallCount = 0;

  release(): void {
    this.releaseCallCount += 1;
  }

  isReleased(): boolean {
    return this.releaseCallCount > 0;
  }

  releaseCalls(): number {
    return this.releaseCallCount;
  }
}
