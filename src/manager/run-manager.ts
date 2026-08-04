import { randomUUID } from 'node:crypto';

import { createPendingSnapshot } from '../snapshot/create-snapshot.js';
import type {
  ExecutionPlanPin,
  JsonValue,
  RunManager as RunManagerContract,
  RunSnapshot,
  RunSnapshotStore,
} from '../types.js';
import type { WorkflowRuntime } from '../workflow/create-workflow-runtime.js';
import type { ProcessManagerOwnership } from './process-manager-ownership.js';

type RunManagerState = 'idle' | 'starting' | 'started' | 'stopping' | 'stop-failed' | 'disposed';

export class RunManagerController implements RunManagerContract {
  private readonly ownership: ProcessManagerOwnership;
  private readonly runtime: WorkflowRuntime;
  private readonly snapshots: RunSnapshotStore;
  private state: RunManagerState = 'idle';
  private transition = Promise.resolve();

  constructor(
    runtime: WorkflowRuntime,
    ownership: ProcessManagerOwnership,
    snapshots: RunSnapshotStore,
  ) {
    this.runtime = runtime;
    this.ownership = ownership;
    this.snapshots = snapshots;
  }

  start(): Promise<void> {
    return this.serialize(() => this.startTransition());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopTransition());
  }

  async startRun(request: {
    readonly planPin: ExecutionPlanPin;
    readonly input: JsonValue;
  }): Promise<RunSnapshot> {
    const snapshot = createPendingSnapshot(randomUUID(), request.planPin, request.input);
    const admission = await this.serialize(async () => {
      if (this.state !== 'started') {
        throw new Error('Run manager is not started.');
      }
      return this.runtime.submit(snapshot);
    });
    return admission.acknowledgement;
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    const read = await this.serialize(async () => {
      if (this.state !== 'started') {
        throw new Error('Run manager is not started.');
      }
      return { result: this.snapshots.get(runId) };
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
