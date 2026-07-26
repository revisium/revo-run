import type { RunEventIntent } from '../domain/index.js';
import type { RunStoreHandoffRecordedEventIntent } from './run-store-handoff-recorded-event-intent.js';
import type { RunStoreOwnershipAcquiredEventIntent } from './run-store-ownership-acquired-event-intent.js';

export type RunStoreEventIntent =
  | RunEventIntent
  | RunStoreHandoffRecordedEventIntent
  | RunStoreOwnershipAcquiredEventIntent;
