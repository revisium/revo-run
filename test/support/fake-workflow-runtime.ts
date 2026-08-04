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
  #configureCalls = 0;
  #disposeCalls = 0;
  #launchCalls = 0;
  #launchFailure: Error | undefined;
  #shutdownCalls = 0;
  #shutdownFailure: Error | undefined;
  #shutdownGate: ReturnType<typeof deferred> | undefined;

  configure(): void {
    this.#configureCalls += 1;
  }

  dispose(): void {
    this.#disposeCalls += 1;
  }

  async launch(): Promise<void> {
    this.#launchCalls += 1;
    if (this.#launchFailure) {
      const error = this.#launchFailure;
      this.#launchFailure = undefined;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.#shutdownCalls += 1;
    if (this.#shutdownFailure) {
      const error = this.#shutdownFailure;
      this.#shutdownFailure = undefined;
      throw error;
    }
    await this.#shutdownGate?.promise;
  }

  async submit(snapshot: RunSnapshot): Promise<RunSnapshot> {
    return snapshot;
  }

  failNextLaunch(error = new Error('launch failed')): void {
    this.#launchFailure = error;
  }

  failNextShutdown(error = new Error('shutdown failed')): void {
    this.#shutdownFailure = error;
  }

  deferShutdown(): void {
    this.#shutdownGate = deferred();
  }

  completeShutdown(): void {
    this.#shutdownGate?.resolve();
    this.#shutdownGate = undefined;
  }

  configureCalls(): number {
    return this.#configureCalls;
  }

  disposeCalls(): number {
    return this.#disposeCalls;
  }

  launchCalls(): number {
    return this.#launchCalls;
  }

  shutdownCalls(): number {
    return this.#shutdownCalls;
  }
}

export class FakeProcessManagerOwnership {
  #releaseCalls = 0;

  release(): void {
    this.#releaseCalls += 1;
  }

  isReleased(): boolean {
    return this.#releaseCalls > 0;
  }

  releaseCalls(): number {
    return this.#releaseCalls;
  }
}
