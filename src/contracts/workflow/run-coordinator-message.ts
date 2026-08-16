import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  AttemptIdSchema,
  AuthoredNodeIdSchema,
  NodeInstanceIdSchema,
  RunWorkflowIdSchema,
  ScopeIdSchema,
  ScopeWorkflowIdSchema,
} from '../execution-identity.js';
import { RunExecutorRequestSchema } from '../executor/run-executor.js';
import {
  ConsensusPolicySchema,
  HumanGateDecisionSchema,
  RemainingBranchPolicySchema,
} from '../pipeline/pipeline-node.schema.js';
import { RecoveryPolicySchema, RetryPolicySchema } from '../pipeline/task-policy.js';
import { CommandIdSchema } from '../run/run-command.js';
import { PipelineEventDraftSchema } from '../run/run-event.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  PipelineNodePathSchema,
  PositiveSafeIntegerSchema,
} from '../schema-primitives.js';
import { ParticipantSettlementSchema } from './participant-settlement.js';
import { CommandDispatchWorkflowInputSchema } from './run-command-workflow.js';

const EventMessageSchema = Type.Object(
  {
    kind: Type.Literal('event'),
    workflowId: ScopeWorkflowIdSchema,
    event: PipelineEventDraftSchema,
  },
  { additionalProperties: false },
);

const ReserveExecutionMessageSchema = Type.Object(
  {
    kind: Type.Literal('reserveExecution'),
    attemptId: AttemptIdSchema,
    replyWorkflowId: ScopeWorkflowIdSchema,
    permitCommandId: Type.Optional(CommandIdSchema),
  },
  { additionalProperties: false },
);

const ScopeAdmissionMessageSchema = Type.Object(
  {
    kind: Type.Literal('scopeAdmission'),
    requestId: NonEmptyStringSchema,
    workflowId: ScopeWorkflowIdSchema,
    parentWorkflowId: ScopeWorkflowIdSchema,
  },
  { additionalProperties: false },
);

const ScopeReadyMessageSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('scopeReady'),
      workflowId: ScopeWorkflowIdSchema,
      parentWorkflowId: RunWorkflowIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('scopeReady'),
      requestId: NonEmptyStringSchema,
      admissionId: NonEmptyStringSchema,
      workflowId: ScopeWorkflowIdSchema,
      parentWorkflowId: ScopeWorkflowIdSchema,
    },
    { additionalProperties: false },
  ),
]);

const ScopeBoundaryMessageSchema = Type.Object(
  {
    kind: Type.Literal('scopeBoundary'),
    workflowId: ScopeWorkflowIdSchema,
    boundaryId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const InlineScopeOwnershipMessageSchema = Type.Object(
  {
    kind: Type.Literal('inlineScopeOwnership'),
    workflowId: ScopeWorkflowIdSchema,
    parentScopeId: ScopeIdSchema,
    scopeId: ScopeIdSchema,
    authoredNodeId: AuthoredNodeIdSchema,
    invocationOrdinal: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

const ScopeFinishMessageSchema = Type.Object(
  { kind: Type.Literal('scopeFinish'), workflowId: ScopeWorkflowIdSchema },
  { additionalProperties: false },
);

const ScopeSettledMessageSchema = Type.Object(
  { kind: Type.Literal('scopeSettled'), workflowId: ScopeWorkflowIdSchema },
  { additionalProperties: false },
);

const ScopeCancellationMessageSchema = Type.Object(
  {
    kind: Type.Literal('scopeCancellation'),
    workflowId: ScopeWorkflowIdSchema,
    joinNodeInstanceId: NodeInstanceIdSchema,
    childWorkflowIds: Type.Array(ScopeWorkflowIdSchema, { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);

const UnknownOutcomeWaitingMessageSchema = Type.Object(
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

const HumanGateWaitingMessageSchema = Type.Object(
  {
    kind: Type.Literal('humanGateWaiting'),
    workflowId: ScopeWorkflowIdSchema,
    gateInstanceId: NodeInstanceIdSchema,
    scopeId: ScopeIdSchema,
    authoredNodeId: AuthoredNodeIdSchema,
    answers: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
    decision: HumanGateDecisionSchema,
    eligibleGroup: Type.Optional(IdentifierSchema),
    timeoutMs: Type.Optional(PositiveSafeIntegerSchema),
  },
  { additionalProperties: false },
);

const HumanGateDeadlineReachedMessageSchema = Type.Object(
  {
    kind: Type.Literal('humanGateDeadlineReached'),
    workflowId: ScopeWorkflowIdSchema,
    gateInstanceId: NodeInstanceIdSchema,
  },
  { additionalProperties: false },
);

const ConsensusParticipantIdentitySchema = Type.Object(
  {
    participantId: IdentifierSchema,
    scopeId: ScopeIdSchema,
    authoredNodeId: AuthoredNodeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
  },
  { additionalProperties: false },
);

const ConsensusWaitingMessageSchema = Type.Object(
  {
    kind: Type.Literal('consensusWaiting'),
    workflowId: ScopeWorkflowIdSchema,
    consensusNodeInstanceId: NodeInstanceIdSchema,
    scopeId: ScopeIdSchema,
    authoredNodeId: AuthoredNodeIdSchema,
    pipelineId: IdentifierSchema,
    nodePath: PipelineNodePathSchema,
    participantIds: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
    participantInstances: Type.Array(ConsensusParticipantIdentitySchema, { minItems: 1 }),
    policy: ConsensusPolicySchema,
    remaining: RemainingBranchPolicySchema,
    timeoutMs: Type.Optional(PositiveSafeIntegerSchema),
  },
  { additionalProperties: false },
);

const ConsensusDeadlineReachedMessageSchema = Type.Object(
  {
    kind: Type.Literal('consensusDeadlineReached'),
    workflowId: ScopeWorkflowIdSchema,
    consensusNodeInstanceId: NodeInstanceIdSchema,
  },
  { additionalProperties: false },
);

const ConsensusParticipantSettledMessageSchema = Type.Object(
  {
    kind: Type.Literal('consensusParticipantSettled'),
    workflowId: ScopeWorkflowIdSchema,
    consensusNodeInstanceId: NodeInstanceIdSchema,
    participantId: IdentifierSchema,
    settlement: ParticipantSettlementSchema,
  },
  { additionalProperties: false },
);

export const RunCoordinatorMessageSchema = Type.Union([
  EventMessageSchema,
  ReserveExecutionMessageSchema,
  ScopeAdmissionMessageSchema,
  ScopeReadyMessageSchema,
  ScopeBoundaryMessageSchema,
  InlineScopeOwnershipMessageSchema,
  ScopeFinishMessageSchema,
  ScopeSettledMessageSchema,
  ScopeCancellationMessageSchema,
  UnknownOutcomeWaitingMessageSchema,
  HumanGateWaitingMessageSchema,
  HumanGateDeadlineReachedMessageSchema,
  ConsensusWaitingMessageSchema,
  ConsensusDeadlineReachedMessageSchema,
  ConsensusParticipantSettledMessageSchema,
  CommandDispatchWorkflowInputSchema,
]);

export type RunCoordinatorMessage = DeepReadonly<Type.Static<typeof RunCoordinatorMessageSchema>>;

export const ExecutionReservationSchema = Type.Object(
  { attemptId: AttemptIdSchema, granted: Type.Boolean() },
  { additionalProperties: false },
);

export type ExecutionReservation = DeepReadonly<Type.Static<typeof ExecutionReservationSchema>>;

const ScopeStartFenceIdentity = {
  requestId: NonEmptyStringSchema,
  admissionId: NonEmptyStringSchema,
  workflowId: ScopeWorkflowIdSchema,
};

export const ScopeCancellationFenceSchema = Type.Union([
  Type.Object(
    { source: Type.Literal('joinDecision'), id: NodeInstanceIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { source: Type.Literal('parent'), id: ScopeWorkflowIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { source: Type.Literal('run'), id: NonEmptyStringSchema },
    { additionalProperties: false },
  ),
]);

export type ScopeCancellationFence = DeepReadonly<Type.Static<typeof ScopeCancellationFenceSchema>>;

export const ScopeStartFenceReplySchema = Type.Union([
  Type.Object(
    { ...ScopeStartFenceIdentity, directive: Type.Literal('start') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ScopeStartFenceIdentity,
      directive: Type.Literal('startCancelled'),
      cancellation: ScopeCancellationFenceSchema,
    },
    { additionalProperties: false },
  ),
]);

export type ScopeStartFenceReply = DeepReadonly<Type.Static<typeof ScopeStartFenceReplySchema>>;
