import type { RunConflict } from '../errors/index.js';

export interface LifecycleConflictResult {
  readonly kind: 'conflict';
  readonly conflict: RunConflict;
}
