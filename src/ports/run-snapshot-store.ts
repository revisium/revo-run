import type { RunManagerSnapshot } from '../spec/index.js';

/**
 * Provisional MVP seam for persisting and reading runner snapshots.
 * It is not the authoritative durable RunStore and expires under ADR 0004.
 */
export interface RunSnapshotStore {
  create(snapshot: RunManagerSnapshot): Promise<void>;
  get(runId: string): Promise<RunManagerSnapshot | undefined>;
  update(snapshot: RunManagerSnapshot): Promise<void>;
}
