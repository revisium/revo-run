import type { RunOutputPayload } from './run-output-payload.js';

export interface ExecutorOutput {
  readonly name: string;
  readonly payload: RunOutputPayload;
}
