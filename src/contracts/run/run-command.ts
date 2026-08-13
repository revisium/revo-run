import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { AttemptIdSchema } from '../execution-identity.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { IdentifierSchema } from '../schema-primitives.js';
import { RunIdSchema } from './run-id.js';

export const CommandIdSchema = Type.String({
  pattern: '^cmd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export type CommandId = DeepReadonly<Type.Static<typeof CommandIdSchema>>;

export const CancelRunInputSchema = Type.Object(
  { runId: RunIdSchema, actorId: IdentifierSchema },
  { additionalProperties: false },
);

export type CancelRunInput = DeepReadonly<Type.Static<typeof CancelRunInputSchema>>;

const UnknownOutcomeResolutionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('adoptSuccess'),
      outcome: IdentifierSchema,
      output: Type.Optional(NodeOutputSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('markFailed') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('retry') }, { additionalProperties: false }),
]);

export const ResolveUnknownOutcomeInputSchema = Type.Object(
  {
    runId: RunIdSchema,
    attemptId: AttemptIdSchema,
    actorId: IdentifierSchema,
    resolution: UnknownOutcomeResolutionSchema,
  },
  { additionalProperties: false },
);

export type ResolveUnknownOutcomeInput = DeepReadonly<
  Type.Static<typeof ResolveUnknownOutcomeInputSchema>
>;

export const RunCommandRejectionReasonSchema = Type.Union([
  Type.Literal('run_already_terminal'),
  Type.Literal('run_cancellation_requested'),
  Type.Literal('unknown_outcome_not_pending'),
  Type.Literal('unknown_outcome_already_resolved'),
  Type.Literal('unknown_outcome_retry_not_permitted'),
  Type.Literal('unsupported_run_version'),
  Type.Literal('command_not_supported'),
]);

export type RunCommandRejectionReason = DeepReadonly<
  Type.Static<typeof RunCommandRejectionReasonSchema>
>;

export const RunCommandReceiptSchema = Type.Union([
  Type.Object(
    { status: Type.Literal('accepted'), commandId: CommandIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal('rejected'),
      commandId: CommandIdSchema,
      reason: RunCommandRejectionReasonSchema,
    },
    { additionalProperties: false },
  ),
]);

export type RunCommandReceipt = DeepReadonly<Type.Static<typeof RunCommandReceiptSchema>>;
