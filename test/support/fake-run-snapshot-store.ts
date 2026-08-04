import type { RunSnapshot, RunSnapshotStore } from '../../src/types.js';

export class FakeRunSnapshotStore implements RunSnapshotStore {
  private deferredGet:
    | {
        readonly promise: Promise<RunSnapshot | undefined>;
        resolve(snapshot: RunSnapshot | undefined): void;
      }
    | undefined;
  private getPending = false;
  private nextGetFailure: Error | undefined;

  async create(): Promise<void> {}

  async update(): Promise<void> {}

  async get(): Promise<RunSnapshot | undefined> {
    this.getPending = true;
    try {
      if (this.nextGetFailure) {
        const error = this.nextGetFailure;
        this.nextGetFailure = undefined;
        throw error;
      }
      return await this.deferredGet?.promise;
    } finally {
      this.getPending = false;
    }
  }

  deferNextGet(): void {
    let resolve!: (snapshot: RunSnapshot | undefined) => void;
    const promise = new Promise<RunSnapshot | undefined>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.deferredGet = { promise, resolve };
  }

  completeGet(snapshot: RunSnapshot | undefined): void {
    this.deferredGet?.resolve(snapshot);
    this.deferredGet = undefined;
  }

  failNextGet(error = new Error('snapshot read failed')): void {
    this.nextGetFailure = error;
  }

  isGetPending(): boolean {
    return this.getPending;
  }
}
