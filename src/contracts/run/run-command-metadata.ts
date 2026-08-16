import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { AttemptIdSchema, NodeInstanceIdSchema } from '../execution-identity.js';
import { IdentifierSchema } from '../schema-primitives.js';
import { CommandIdSchema } from './run-command.js';

const CancelMetadataSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    commandKind: Type.Literal('cancelRun'),
    actorId: IdentifierSchema,
  },
  { additionalProperties: false },
);
const AnswerGateMetadataSchema = Type.Object(
  {
    commandId: CommandIdSchema,
    commandKind: Type.Literal('answerGate'),
    gateInstanceId: NodeInstanceIdSchema,
    actorId: IdentifierSchema,
    answer: IdentifierSchema,
  },
  { additionalProperties: false },
);
const ResolutionMetadataFields = {
  commandId: CommandIdSchema,
  commandKind: Type.Literal('resolveUnknownOutcome'),
  actorId: IdentifierSchema,
  attemptId: AttemptIdSchema,
};
const AdoptMetadataSchema = Type.Object(
  {
    ...ResolutionMetadataFields,
    resolutionKind: Type.Literal('adoptSuccess'),
    outcome: IdentifierSchema,
  },
  { additionalProperties: false },
);
const MarkFailedMetadataSchema = Type.Object(
  { ...ResolutionMetadataFields, resolutionKind: Type.Literal('markFailed') },
  { additionalProperties: false },
);
const RetryMetadataSchema = Type.Object(
  { ...ResolutionMetadataFields, resolutionKind: Type.Literal('retry') },
  { additionalProperties: false },
);

export const RunCommandRequestMetadataSchema = Type.Union([
  CancelMetadataSchema,
  AnswerGateMetadataSchema,
  AdoptMetadataSchema,
  MarkFailedMetadataSchema,
  RetryMetadataSchema,
]);

const ResolveRejectionReasonSchema = Type.Union([
  Type.Literal('run_cancellation_requested'),
  Type.Literal('unknown_outcome_not_pending'),
  Type.Literal('unknown_outcome_already_resolved'),
]);
const RetryRejectionReasonSchema = Type.Union([
  ResolveRejectionReasonSchema,
  Type.Literal('unknown_outcome_retry_not_permitted'),
]);
const GateRejectionReasonSchema = Type.Union([
  Type.Literal('actor_already_answered'),
  Type.Literal('actor_not_eligible'),
  Type.Literal('gate_already_resolved'),
  Type.Literal('invalid_gate_answer'),
]);

export const RunCommandAcceptedMetadataSchema = Type.Union([
  CancelMetadataSchema,
  AnswerGateMetadataSchema,
  AdoptMetadataSchema,
  MarkFailedMetadataSchema,
  RetryMetadataSchema,
]);

export const RunCommandRejectedMetadataSchema = Type.Union([
  Type.Object(
    { ...AnswerGateMetadataSchema.properties, reason: GateRejectionReasonSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...AdoptMetadataSchema.properties, reason: ResolveRejectionReasonSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...MarkFailedMetadataSchema.properties, reason: ResolveRejectionReasonSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...RetryMetadataSchema.properties, reason: RetryRejectionReasonSchema },
    { additionalProperties: false },
  ),
]);

export const RunCommandDecisionSchema = Type.Union([
  Type.Object(
    { ...CancelMetadataSchema.properties, decision: Type.Literal('accepted') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...AnswerGateMetadataSchema.properties, decision: Type.Literal('accepted') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...AdoptMetadataSchema.properties, decision: Type.Literal('accepted') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...MarkFailedMetadataSchema.properties, decision: Type.Literal('accepted') },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...RetryMetadataSchema.properties, decision: Type.Literal('accepted') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AnswerGateMetadataSchema.properties,
      decision: Type.Literal('rejected'),
      reason: GateRejectionReasonSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AdoptMetadataSchema.properties,
      decision: Type.Literal('rejected'),
      reason: ResolveRejectionReasonSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...MarkFailedMetadataSchema.properties,
      decision: Type.Literal('rejected'),
      reason: ResolveRejectionReasonSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...RetryMetadataSchema.properties,
      decision: Type.Literal('rejected'),
      reason: RetryRejectionReasonSchema,
    },
    { additionalProperties: false },
  ),
]);

export type RunCommandRequestMetadata = DeepReadonly<
  Type.Static<typeof RunCommandRequestMetadataSchema>
>;
export type RunCommandAcceptedMetadata = DeepReadonly<
  Type.Static<typeof RunCommandAcceptedMetadataSchema>
>;
export type RunCommandRejectedMetadata = DeepReadonly<
  Type.Static<typeof RunCommandRejectedMetadataSchema>
>;
export type RunCommandDecision = DeepReadonly<Type.Static<typeof RunCommandDecisionSchema>>;
