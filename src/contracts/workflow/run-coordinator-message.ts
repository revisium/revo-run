import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { AttemptIdSchema, ScopeWorkflowIdSchema } from '../execution-identity.js';
import { IdentifierSchema, NonEmptyStringSchema } from '../schema-primitives.js';

const EventMessageSchema = Type.Object(
  {
    kind: Type.Literal('event'),
    event: Type.Object(
      {
        type: NonEmptyStringSchema,
        path: Type.Optional(NonEmptyStringSchema),
        errorCode: Type.Optional(IdentifierSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ReserveExecutionMessageSchema = Type.Object(
  {
    kind: Type.Literal('reserveExecution'),
    attemptId: AttemptIdSchema,
    replyWorkflowId: ScopeWorkflowIdSchema,
  },
  { additionalProperties: false },
);

const ScopeRegisteredMessageSchema = Type.Object(
  {
    kind: Type.Literal('scopeRegistered'),
    workflowId: ScopeWorkflowIdSchema,
  },
  { additionalProperties: false },
);

const ScopeSettledMessageSchema = Type.Object(
  {
    kind: Type.Literal('scopeSettled'),
    workflowId: ScopeWorkflowIdSchema,
  },
  { additionalProperties: false },
);

export const RunCoordinatorMessageSchema = Type.Union([
  EventMessageSchema,
  ReserveExecutionMessageSchema,
  ScopeRegisteredMessageSchema,
  ScopeSettledMessageSchema,
]);

export type RunCoordinatorMessage = DeepReadonly<Type.Static<typeof RunCoordinatorMessageSchema>>;

export const ExecutionReservationSchema = Type.Object(
  {
    attemptId: AttemptIdSchema,
    granted: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type ExecutionReservation = DeepReadonly<Type.Static<typeof ExecutionReservationSchema>>;
