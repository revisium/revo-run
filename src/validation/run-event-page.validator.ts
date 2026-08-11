import Schema from 'typebox/schema';

import {
  RunEventCursorSchema,
  RunEventPageInputSchema,
  RunEventSubscriptionInputSchema,
  type RunEventCursor,
  type RunEventPageInput,
  type RunEventSubscriptionInput,
} from '../contracts/run/run-event-page.js';

const CursorValidator = Schema.Compile(RunEventCursorSchema);
const PageInputValidator = Schema.Compile(RunEventPageInputSchema);
const SubscriptionInputValidator = Schema.Compile(RunEventSubscriptionInputSchema);

export const isRunEventCursor = (value: unknown): value is RunEventCursor =>
  CursorValidator.Check(value);

export const isRunEventPageInput = (value: unknown): value is RunEventPageInput =>
  PageInputValidator.Check(value);

export const isRunEventSubscriptionInput = (value: unknown): value is RunEventSubscriptionInput =>
  SubscriptionInputValidator.Check(value);

export const runEventCursorRunId = (cursor: RunEventCursor): string =>
  cursor.slice(0, cursor.lastIndexOf(':'));

export const runEventCursorSequence = (cursor: RunEventCursor): number =>
  Number(cursor.slice(cursor.lastIndexOf(':') + 1));
