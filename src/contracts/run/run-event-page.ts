import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { RunEventCursorSchema } from './run-event-cursor.js';
import { RunEventSchema } from './run-event.js';

export const RunEventPageInputSchema = Type.Object(
  {
    after: Type.Optional(RunEventCursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const RunEventPageSchema = Type.Refine(
  Type.Object(
    {
      items: Type.Array(RunEventSchema),
      nextCursor: Type.Optional(RunEventCursorSchema),
      hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  (page) => {
    const last = page.items.at(-1);
    return last === undefined ? page.nextCursor === undefined : page.nextCursor === last.cursor;
  },
);

export const RunEventSubscriptionInputSchema = Type.Object(
  { after: Type.Optional(RunEventCursorSchema) },
  { additionalProperties: false },
);

export type RunEventPageInput = DeepReadonly<Type.Static<typeof RunEventPageInputSchema>>;
export type RunEventPage = DeepReadonly<Type.Static<typeof RunEventPageSchema>>;
export type RunEventSubscriptionInput = DeepReadonly<
  Type.Static<typeof RunEventSubscriptionInputSchema>
>;

export { RunEventCursorSchema } from './run-event-cursor.js';
export type { RunEventCursor } from './run-event-cursor.js';
