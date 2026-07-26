import type { MaterializeRunStoreEvent } from './materialize-run-store-event.js';
import type { RunStoreEventIntent } from './run-store-event-intent.js';

export type RunStoreEvent = MaterializeRunStoreEvent<RunStoreEventIntent>;
