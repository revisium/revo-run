import type { RunSnapshot } from '../../src/types.js';
import type { WorkflowRuntime } from '../../src/workflow/create-workflow-runtime.js';

export class FakeWorkflowRuntime implements WorkflowRuntime {
  configureCalls = 0;
  disposeCalls = 0;
  launchCalls = 0;
  shutdownCalls = 0;
  launchResult: Promise<void> = Promise.resolve();
  shutdownResult: Promise<void> = Promise.resolve();

  configure(): void {
    this.configureCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  launch(): Promise<void> {
    this.launchCalls += 1;
    return this.launchResult;
  }

  shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return this.shutdownResult;
  }

  async submit(snapshot: RunSnapshot): Promise<RunSnapshot> {
    return snapshot;
  }
}
