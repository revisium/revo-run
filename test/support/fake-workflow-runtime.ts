import type { RunSnapshot } from '../../src/types.js';
import type { WorkflowRuntime } from '../../src/workflow/create-workflow-runtime.js';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

export class FakeWorkflowRuntime implements WorkflowRuntime {
  private configureCallCount = 0;
  private disposeCallCount = 0;
  private launchCallCount = 0;
  private launchFailure: Error | undefined;
  private shutdownCallCount = 0;
  private shutdownFailure: Error | undefined;
  private shutdownGate: ReturnType<typeof deferred> | undefined;

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

  async submit(snapshot: RunSnapshot): Promise<RunSnapshot> {
    return snapshot;
  }

  failNextLaunch(error = new Error('launch failed')): void {
    this.launchFailure = error;
  }

  failNextShutdown(error = new Error('shutdown failed')): void {
    this.shutdownFailure = error;
  }

  deferShutdown(): void {
    this.shutdownGate = deferred();
  }

  completeShutdown(): void {
    this.shutdownGate?.resolve();
    this.shutdownGate = undefined;
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
