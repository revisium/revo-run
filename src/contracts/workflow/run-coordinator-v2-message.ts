import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { AttemptIdSchema, ScopeWorkflowV2IdSchema } from '../execution-identity.js';
import { CommandIdSchema } from '../run/run-command.js';
import { PipelineEventDraftSchema } from '../run/run-event.js';
import {
  CommandDispatchWorkflowInputSchema,
  ScopeBoundarySchema,
  ScopeFinishSchema,
  ScopeReadySchema,
  UnknownOutcomeWaitingSchema,
} from './run-command-workflow.js';

const EventMessageSchema = Type.Object(
  {
    kind: Type.Literal('event'),
    workflowId: ScopeWorkflowV2IdSchema,
    event: PipelineEventDraftSchema,
  },
  { additionalProperties: false },
);

const ReserveExecutionMessageSchema = Type.Object(
  {
    kind: Type.Literal('reserveExecution'),
    attemptId: AttemptIdSchema,
    replyWorkflowId: ScopeWorkflowV2IdSchema,
    permitCommandId: Type.Optional(CommandIdSchema),
  },
  { additionalProperties: false },
);

const ScopeRegisteredMessageSchema = Type.Object(
  {
    kind: Type.Literal('scopeRegistered'),
    workflowId: ScopeWorkflowV2IdSchema,
    parentWorkflowId: ScopeWorkflowV2IdSchema,
  },
  { additionalProperties: false },
);

const ScopeSettledMessageSchema = Type.Object(
  {
    kind: Type.Literal('scopeSettled'),
    workflowId: ScopeWorkflowV2IdSchema,
  },
  { additionalProperties: false },
);

export const RunCoordinatorV2MessageSchema = Type.Union([
  EventMessageSchema,
  ReserveExecutionMessageSchema,
  ScopeRegisteredMessageSchema,
  ScopeReadySchema,
  ScopeBoundarySchema,
  ScopeFinishSchema,
  ScopeSettledMessageSchema,
  UnknownOutcomeWaitingSchema,
  CommandDispatchWorkflowInputSchema,
]);

export type RunCoordinatorV2Message = DeepReadonly<
  Type.Static<typeof RunCoordinatorV2MessageSchema>
>;

export const ExecutionReservationV2Schema = Type.Object(
  {
    attemptId: AttemptIdSchema,
    granted: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type ExecutionReservationV2 = DeepReadonly<Type.Static<typeof ExecutionReservationV2Schema>>;
