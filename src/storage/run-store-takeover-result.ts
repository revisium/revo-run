import type { Attempt, Run, RunNodeInstance } from '../domain/index.js';
import type { AttemptHandoffConsumption } from './attempt-handoff-consumption.js';

export type RunStoreTakeoverResult =
  | {
      readonly evidence: 'lease_expired';
      readonly run: Run;
      readonly node: RunNodeInstance;
      readonly attempt: Attempt;
      readonly handoffConsumption: null;
    }
  | {
      readonly evidence: 'handoff';
      readonly run: Run;
      readonly node: RunNodeInstance;
      readonly attempt: Attempt;
      readonly handoffConsumption: AttemptHandoffConsumption;
    };
