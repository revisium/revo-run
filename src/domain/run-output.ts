import type { RunId, RunOutputId, RunOutputPayload } from '../spec/index.js';
import type { RunCorrelation } from './run-correlation.js';

export interface RunOutput {
  readonly id: RunOutputId;
  readonly runId: RunId;
  readonly name: string;
  readonly payload: RunOutputPayload;
  readonly createdAt: number;
  readonly correlation: RunCorrelation;
}
