import type {
  RunManager as RunManagerContract,
  RunSnapshot,
  StartRunInput,
  StartRunResult,
} from '../types.js';
import type { WorkflowRuntime } from '../workflow/create-workflow-runtime.js';
import type { ProcessManagerOwnership } from './process-manager-ownership.js';
import { snapshotStartRunInput } from './snapshot-run-input.js';

type RunManagerState = 'idle' | 'starting' | 'started' | 'stopping' | 'stop-failed' | 'disposed';

export class RunManagerController implements RunManagerContract {
  private readonly ownership: ProcessManagerOwnership;
  private readonly runtime: WorkflowRuntime;
  private state: RunManagerState = 'idle';
  private transition = Promise.resolve();

  constructor(runtime: WorkflowRuntime, ownership: ProcessManagerOwnership) {
    this.runtime = runtime;
    this.ownership = ownership;
  }

  start(): Promise<void> {
    return this.serialize(() => this.startTransition());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopTransition());
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    if (typeof input.runId !== 'string' || input.runId.length === 0) {
      throw new TypeError('Run ID must be a non-empty string.');
    }
    const snapshot = snapshotStartRunInput(input);
    await this.serialize(async () => {
      if (this.state !== 'started') {
        throw new Error('Run manager is not started.');
      }
      await this.runtime.submit(snapshot.runId, snapshot.executionPlan, snapshot.input);
    });
    return { runId: snapshot.runId };
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    if (runId.length === 0) {
      throw new TypeError('Run ID must be a non-empty string.');
    }
    const read = await this.serialize(async () => {
      if (this.state !== 'started') {
        throw new Error('Run manager is not started.');
      }
      return { result: this.runtime.get(runId) };
    });
    return read.result;
  }

  private async startTransition(): Promise<void> {
    if (this.state === 'disposed') {
      throw new Error('Run manager has been stopped.');
    }
    if (this.state === 'started') {
      return;
    }
    if (this.state === 'stop-failed') {
      throw new Error('Run manager shutdown state is uncertain; stop must be retried.');
    }

    this.state = 'starting';
    try {
      this.runtime.configure();
      await this.runtime.launch();
      this.state = 'started';
    } catch (error: unknown) {
      this.state = 'idle';
      throw error;
    }
  }

  private async stopTransition(): Promise<void> {
    if (this.state === 'disposed') {
      return;
    }
    if (this.state === 'idle') {
      this.dispose();
      return;
    }

    this.state = 'stopping';
    try {
      await this.runtime.shutdown();
      this.dispose();
    } catch (error: unknown) {
      this.state = 'stop-failed';
      throw error;
    }
  }

  private dispose(): void {
    this.state = 'disposed';
    this.runtime.dispose();
    this.ownership.release();
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.transition.then(operation);
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
