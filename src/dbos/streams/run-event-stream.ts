import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunEvent, RunEventDraft } from '../../contracts/run/run-event.js';
import type { RunId } from '../../contracts/run/run-id.js';
import { runEventStreamName } from '../dbos-names.js';

const maximumStoredRunEvents = 100_000;
export const maximumStoredRunEventBytes = 16_384;

export type RunEventBudgetFailure =
  | 'maximum_run_event_bytes_exceeded'
  | 'maximum_run_event_count_exceeded';

export class RunEventBudgetExceededError extends Error {
  readonly outcome: RunEventBudgetFailure;

  constructor(outcome: RunEventBudgetFailure) {
    super(outcome);
    this.name = 'RunEventBudgetExceededError';
    this.outcome = outcome;
  }
}

export const assertRunEventCountWithinBudget = (acceptedCount: number): void => {
  if (acceptedCount >= maximumStoredRunEvents) {
    throw new RunEventBudgetExceededError('maximum_run_event_count_exceeded');
  }
};

export const assertRunEventBytesWithinBudget = (
  byteLength: number,
  maximumBytes = maximumStoredRunEventBytes,
): void => {
  if (byteLength > maximumBytes) {
    throw new RunEventBudgetExceededError('maximum_run_event_bytes_exceeded');
  }
};

export const serializedUtf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export class DbosRunEventStream {
  private acceptedCount = 0;
  private readonly maximumEventBytes: number;
  private readonly runId: RunId;

  constructor(runId: RunId, maximumEventBytes = maximumStoredRunEventBytes) {
    this.runId = runId;
    this.maximumEventBytes = maximumEventBytes;
  }

  async append(eventDraft: RunEventDraft): Promise<void> {
    assertRunEventCountWithinBudget(this.acceptedCount);

    const sequence = this.acceptedCount + 1;
    const event: RunEvent = {
      cursor: `${this.runId}:${sequence}`,
      timestamp: new Date(await DBOS.now()).toISOString(),
      ...eventDraft,
    };
    assertRunEventBytesWithinBudget(serializedUtf8Bytes(event), this.maximumEventBytes);

    await DBOS.writeStream(runEventStreamName, event);
    this.acceptedCount = sequence;
  }

  close(): Promise<void> {
    return DBOS.closeStream(runEventStreamName);
  }
}
