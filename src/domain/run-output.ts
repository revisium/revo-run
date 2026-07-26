import type { RunOutputPayload } from '../spec/index.js';
import type { RunCorrelation } from './run-correlation.js';

export interface RunOutput {
  readonly id: string;
  readonly runId: string;
  readonly name: string;
  readonly payload: RunOutputPayload;
  readonly createdAt: number;
  readonly correlation: RunCorrelation;
}
