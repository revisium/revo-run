import type { AttemptHandoffConsumption } from './attempt-handoff-consumption.js';
import type { AttemptHandoff } from './attempt-handoff.js';

export interface AttemptHandoffState {
  readonly handoff: AttemptHandoff;
  readonly consumption: AttemptHandoffConsumption | null;
}
