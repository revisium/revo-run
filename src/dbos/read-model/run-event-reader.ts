import { DBOS } from '@dbos-inc/dbos-sdk';

import type {
  RunEventCursor,
  RunEventPage,
  RunEventPageInput,
  RunEventSubscriptionInput,
} from '../../contracts/run/run-event-page.js';
import type { RunEvent } from '../../contracts/run/run-event.js';
import { RunManagerError } from '../../contracts/run/run-manager-error.js';
import {
  isRunEventCursor,
  runEventCursorRunId,
  runEventCursorSequence,
} from '../../validation/run-event-page.validator.js';
import { parseRunEvent } from '../../validation/run-event.validator.js';
import { runEventStreamName } from '../dbos-names.js';
import { runWorkflowId } from '../workflow-id.js';
import { countWorkflowStepsByName } from './dbos-step-pages.js';

export const dbosWriteStreamStepName = 'DBOS.writeStream';
const defaultPageLimit = 50;

const highWater = async (runId: string): Promise<number> => {
  return countWorkflowStepsByName(runWorkflowId(runId), dbosWriteStreamStepName);
};

const sequenceAfter = (runId: string, cursor: RunEventCursor | undefined): number => {
  if (cursor === undefined) {
    return 0;
  }
  if (runEventCursorRunId(cursor) !== runId) {
    throw new RunManagerError('invalid_run_event_cursor');
  }
  return runEventCursorSequence(cursor);
};

const parseStoredEvent = (value: unknown, runId: string, sequence: number): RunEvent => {
  const event = parseRunEvent(value);
  if (event.cursor !== `${runId}:${sequence}`) {
    throw new RunManagerError('run_read_failed');
  }
  return event;
};

const cursorAfter = (
  input: RunEventPageInput | RunEventSubscriptionInput,
): RunEventCursor | undefined => input.after;

const validatedPosition = (
  runId: string,
  cursor: RunEventCursor | undefined,
  maximumSequence: number,
): number => {
  const position = sequenceAfter(runId, cursor);
  if (position > maximumSequence) {
    throw new RunManagerError('invalid_run_event_cursor');
  }
  return position;
};

const replayPage = async (
  runId: string,
  maximumSequence: number,
  position: number,
  limit: number,
): Promise<readonly RunEvent[]> => {
  const items: RunEvent[] = [];
  let observed = 0;
  if (maximumSequence === 0) {
    return items;
  }
  for await (const value of DBOS.readStream<unknown>(runWorkflowId(runId), runEventStreamName)) {
    observed += 1;
    const event = parseStoredEvent(value, runId, observed);
    if (observed > position && items.length < limit) {
      items.push(event);
    }
    if (observed === maximumSequence) {
      break;
    }
  }
  if (observed !== maximumSequence) {
    throw new RunManagerError('run_read_failed');
  }
  return items;
};

const replayAfter = async function* (
  runId: string,
  maximumSequence: number,
  position: number,
): AsyncGenerator<RunEvent> {
  let observed = 0;
  if (maximumSequence === 0) {
    return;
  }
  for await (const value of DBOS.readStream<unknown>(runWorkflowId(runId), runEventStreamName)) {
    observed += 1;
    const event = parseStoredEvent(value, runId, observed);
    if (observed > position) {
      yield event;
    }
    if (observed === maximumSequence) {
      break;
    }
  }
  if (observed !== maximumSequence) {
    throw new RunManagerError('run_read_failed');
  }
};

export const loadRunEventPage = async (
  runId: string,
  input: RunEventPageInput,
): Promise<RunEventPage> => {
  const maximumSequence = await highWater(runId);
  const position = validatedPosition(runId, cursorAfter(input), maximumSequence);
  const items = await replayPage(runId, maximumSequence, position, input.limit ?? defaultPageLimit);
  const hasMore = position + items.length < maximumSequence;
  const last = items.at(-1);
  if (last === undefined) {
    return { items, hasMore };
  }
  if (!isRunEventCursor(last.cursor)) {
    throw new RunManagerError('run_read_failed');
  }
  return { items, nextCursor: last.cursor, hasMore };
};

export const subscribeToRunEvents = async function* (
  runId: string,
  input: RunEventSubscriptionInput,
): AsyncGenerator<RunEvent> {
  const maximumSequence = await highWater(runId);
  const position = validatedPosition(runId, cursorAfter(input), maximumSequence);
  yield* replayAfter(runId, maximumSequence, position);

  let observed = 0;
  for await (const value of DBOS.readStream<unknown>(runWorkflowId(runId), runEventStreamName)) {
    observed += 1;
    const event = parseStoredEvent(value, runId, observed);
    if (observed > maximumSequence) {
      yield event;
    }
  }
  if (observed < maximumSequence) {
    throw new RunManagerError('run_read_failed');
  }
};
