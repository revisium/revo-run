import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  AttemptIdSchema,
  ScopeParentWorkflowIdSchema,
  ScopeWorkflowIdSchema,
} from '../execution-identity.js';
import { RunExecutorRequestSchema } from '../executor/run-executor.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { RecoveryPolicySchema, RetryPolicySchema } from '../pipeline/task-policy.js';
export { RunCommandDecisionSchema, type RunCommandDecision } from '../run/run-command-metadata.js';
import {
  AnswerGateInputSchema,
  CancelRunInputSchema,
  CommandIdSchema,
  ResolveUnknownOutcomeInputSchema,
  RunCommandReceiptSchema,
} from '../run/run-command.js';
import { IdentifierSchema, PositiveSafeIntegerSchema } from '../schema-primitives.js';

const CancelRunCommandSchema = Type.Object(
  { kind: Type.Literal('cancelRun'), input: CancelRunInputSchema },
  { additionalProperties: false },
);

const ResolveUnknownOutcomeCommandSchema = Type.Object(
  { kind: Type.Literal('resolveUnknownOutcome'), input: ResolveUnknownOutcomeInputSchema },
  { additionalProperties: false },
);

const AnswerGateCommandInputSchema = Type.Object(
  {
    runId: AnswerGateInputSchema.properties.runId,
    gateInstanceId: AnswerGateInputSchema.properties.gateInstanceId,
    answer: AnswerGateInputSchema.properties.answer,
    actorId: AnswerGateInputSchema.properties.actorId,
    actorGroups: AnswerGateInputSchema.properties.actorGroups,
  },
  { additionalProperties: false },
);

const AnswerGateCommandSchema = Type.Object(
  { kind: Type.Literal('answerGate'), input: AnswerGateCommandInputSchema },
  { additionalProperties: false },
);

export const DurableRunCommandSchema = Type.Union([
  CancelRunCommandSchema,
  ResolveUnknownOutcomeCommandSchema,
  AnswerGateCommandSchema,
]);

export type DurableRunCommand = DeepReadonly<Type.Static<typeof DurableRunCommandSchema>>;

export const CommandDispatchWorkflowInputSchema = Type.Object(
  { commandId: CommandIdSchema, command: DurableRunCommandSchema },
  { additionalProperties: false },
);

export const CommandDispatchWorkflowArgumentsSchema = Type.Tuple([
  CommandDispatchWorkflowInputSchema,
]);

export type CommandDispatchWorkflowInput = DeepReadonly<
  Type.Static<typeof CommandDispatchWorkflowInputSchema>
>;

export const CommandDispatchWorkflowResultSchema = Type.Union([
  Type.Object(
    { status: Type.Literal('receipt'), receipt: RunCommandReceiptSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal('runNotFound'), commandId: CommandIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal('dispatchFailed'), commandId: CommandIdSchema },
    { additionalProperties: false },
  ),
]);

export type CommandDispatchWorkflowResult = DeepReadonly<
  Type.Static<typeof CommandDispatchWorkflowResultSchema>
>;

export const ScopeReadySchema = Type.Object(
  {
    kind: Type.Literal('scopeReady'),
    workflowId: ScopeWorkflowIdSchema,
    parentWorkflowId: ScopeParentWorkflowIdSchema,
  },
  { additionalProperties: false },
);

export const ScopeBoundarySchema = Type.Object(
  {
    kind: Type.Literal('scopeBoundary'),
    workflowId: ScopeWorkflowIdSchema,
    boundaryId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ScopeFinishSchema = Type.Object(
  {
    kind: Type.Literal('scopeFinish'),
    workflowId: ScopeWorkflowIdSchema,
  },
  { additionalProperties: false },
);

export const ScopeDirectiveSchema = Type.Union([
  Type.Object({ kind: Type.Literal('continue') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('cancel') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('fail') }, { additionalProperties: false }),
]);

export type ScopeDirective = DeepReadonly<Type.Static<typeof ScopeDirectiveSchema>>;

export const ScopeSettlementAcknowledgementSchema = Type.Object(
  { kind: Type.Literal('settled') },
  { additionalProperties: false },
);

export type ScopeSettlementAcknowledgement = DeepReadonly<
  Type.Static<typeof ScopeSettlementAcknowledgementSchema>
>;

export const UnknownOutcomeWaitingSchema = Type.Object(
  {
    kind: Type.Literal('unknownOutcomeWaiting'),
    workflowId: ScopeWorkflowIdSchema,
    request: RunExecutorRequestSchema,
    attemptOrdinal: PositiveSafeIntegerSchema,
    reconciliationRound: PositiveSafeIntegerSchema,
    recovery: RecoveryPolicySchema,
    retry: Type.Optional(RetryPolicySchema),
  },
  { additionalProperties: false },
);

export const UnknownResolutionDirectiveSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('adoptSuccess'),
      commandId: CommandIdSchema,
      outcome: IdentifierSchema,
      output: Type.Optional(NodeOutputSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('markFailed'),
      commandId: CommandIdSchema,
      errorCode: Type.Literal('unknown_outcome_resolved_failed'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('retry'), commandId: CommandIdSchema, attemptId: AttemptIdSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('cancel') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('fail') }, { additionalProperties: false }),
]);

export const unknownOutcomeResolvedFailureCode = 'unknown_outcome_resolved_failed' as const;

export type UnknownResolutionDirective = DeepReadonly<
  Type.Static<typeof UnknownResolutionDirectiveSchema>
>;

export const HumanGateResolutionDirectiveSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('answered'),
      answer: IdentifierSchema,
      commandIds: Type.Array(CommandIdSchema, { minItems: 1, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('conflict') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('timedOut') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('cancel') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('fail') }, { additionalProperties: false }),
]);

export type HumanGateResolutionDirective = DeepReadonly<
  Type.Static<typeof HumanGateResolutionDirectiveSchema>
>;
