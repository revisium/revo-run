import type { AttemptHandoffKey } from './attempt-handoff-key.js';

export interface AttemptHandoffConsumption {
  readonly handoffId: string;
  readonly key: AttemptHandoffKey;
  readonly successorManagerIncarnationId: string;
  readonly successorFencingToken: number;
  readonly consumedAt: number;
}
