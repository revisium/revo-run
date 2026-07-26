import type { RunEventCursor } from './run-event-cursor.js';
import type { RunStoreEventIntent } from './run-store-event-intent.js';

export type MaterializeRunStoreEvent<Intent extends RunStoreEventIntent> =
  Intent extends RunStoreEventIntent
    ? Readonly<
        Intent & {
          readonly sequence: number;
          readonly cursor: RunEventCursor;
          readonly createdAt: number;
        }
      >
    : never;
