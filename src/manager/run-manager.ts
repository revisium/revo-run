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

export class RunManager implements RunManagerContract {
  readonly #ownership: ProcessManagerOwnership;
  readonly #runtime: WorkflowRuntime;
  readonly #snapshots: RunSnapshotStore;
  #state: RunManagerState = 'idle';
  #transition = Promise.resolve();

  constructor(
    runtime: WorkflowRuntime,
    ownership: ProcessManagerOwnership,
    snapshots: RunSnapshotStore,
  ) {
    this.#runtime = runtime;
    this.#ownership = ownership;
    this.#snapshots = snapshots;
  }

  start(): Promise<void> {
    return this.#serialize(() => this.#start());
  }

  stop(): Promise<void> {
    return this.#serialize(() => this.#stop());
  }

  startRun(request: {
    readonly planPin: ExecutionPlanPin;
    readonly input: JsonValue;
  }): Promise<RunSnapshot> {
    const snapshot = createPendingSnapshot(randomUUID(), request.planPin, request.input);
    return this.#serialize(async () => {
      if (this.#state !== 'started') throw new Error('Run manager is not started.');
      return this.#runtime.submit(snapshot);
    });
  }

  getRun(runId: string): Promise<RunSnapshot | undefined> {
    return this.#snapshots.get(runId);
  }

  async #start(): Promise<void> {
    if (this.#state === 'disposed') throw new Error('Run manager has been stopped.');
    if (this.#state === 'started') return;
    if (this.#state === 'stop-failed')
      throw new Error('Run manager shutdown state is uncertain; stop must be retried.');

    this.#state = 'starting';
    try {
      this.#runtime.configure();
      await this.#runtime.launch();
      this.#state = 'started';
    } catch (error: unknown) {
      this.#state = 'idle';
      throw error;
    }
  }

  async #stop(): Promise<void> {
    if (this.#state === 'disposed') return;
    if (this.#state === 'idle') {
      this.#dispose();
      return;
    }

    this.#state = 'stopping';
    try {
      await this.#runtime.shutdown();
      this.#dispose();
    } catch (error: unknown) {
      this.#state = 'stop-failed';
      throw error;
    }
  }

  #dispose(): void {
    this.#state = 'disposed';
    this.#runtime.dispose();
    this.#ownership.release();
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#transition.then(operation);
    this.#transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
