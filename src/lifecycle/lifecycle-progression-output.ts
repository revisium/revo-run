import type { RunOutputPayload } from '../spec/index.js';

export interface LifecycleProgressionOutput {
  readonly outputId: string;
  readonly name: string;
  readonly payload: RunOutputPayload;
}
