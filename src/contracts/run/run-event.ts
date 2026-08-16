import Type from 'typebox';
import type { TSchema } from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  AttemptIdSchema,
  AuthoredNodeIdSchema,
  NodeInstanceIdSchema,
  ScopeIdSchema,
} from '../execution-identity.js';
import { IdentifierSchema, PositiveSafeIntegerSchema } from '../schema-primitives.js';
import {
  RunCommandAcceptedMetadataSchema,
  RunCommandRejectedMetadataSchema,
} from './run-command-metadata.js';
import { RunEventCursorSchema } from './run-event-cursor.js';

const timestampPattern = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

const TimestampSchema = Type.String({ format: 'date-time', pattern: timestampPattern });

const NodeIdentitySchema = Type.Object(
  {
    scopeId: ScopeIdSchema,
    authoredNodeId: AuthoredNodeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
  },
  { additionalProperties: false },
);

const AttemptIdentitySchema = Type.Object(
  {
    scopeId: ScopeIdSchema,
    authoredNodeId: AuthoredNodeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
    attemptId: AttemptIdSchema,
    attemptOrdinal: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

const eventVariant = <EventType extends string, EventData extends TSchema>(
  type: EventType,
  data: EventData,
) => ({
  draft: Type.Object({ type: Type.Literal(type), data }, { additionalProperties: false }),
  stored: Type.Object(
    {
      cursor: RunEventCursorSchema,
      timestamp: TimestampSchema,
      type: Type.Literal(type),
      data,
    },
    { additionalProperties: false },
  ),
});

const nodeExecutionStarted = eventVariant('nodeExecution.started', AttemptIdentitySchema);
const nodeExecutionCompleted = eventVariant(
  'nodeExecution.completed',
  Type.Object(
    {
      scopeId: ScopeIdSchema,
      authoredNodeId: AuthoredNodeIdSchema,
      nodeInstanceId: NodeInstanceIdSchema,
      attemptId: AttemptIdSchema,
      attemptOrdinal: PositiveSafeIntegerSchema,
      outcome: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
);
const nodeExecutionFailed = eventVariant(
  'nodeExecution.failed',
  Type.Object(
    {
      scopeId: ScopeIdSchema,
      authoredNodeId: AuthoredNodeIdSchema,
      nodeInstanceId: NodeInstanceIdSchema,
      attemptId: AttemptIdSchema,
      attemptOrdinal: PositiveSafeIntegerSchema,
      errorCode: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
);
const nodeExecutionRecoveryExhausted = eventVariant(
  'nodeExecution.recoveryExhausted',
  Type.Object(
    {
      scopeId: ScopeIdSchema,
      authoredNodeId: AuthoredNodeIdSchema,
      nodeInstanceId: NodeInstanceIdSchema,
      attemptId: AttemptIdSchema,
      attemptOrdinal: PositiveSafeIntegerSchema,
      reconciliationRound: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
);
const nodeExecutionTimedOut = eventVariant('nodeExecution.timedOut', AttemptIdentitySchema);
const nodeExecutionCancelled = eventVariant('nodeExecution.cancelled', AttemptIdentitySchema);
const inputResolutionFailed = eventVariant(
  'inputResolution.failed',
  Type.Object(
    {
      scopeId: ScopeIdSchema,
      authoredNodeId: AuthoredNodeIdSchema,
      nodeInstanceId: NodeInstanceIdSchema,
      errorCode: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
);
const pipelineInvalidState = eventVariant(
  'pipeline.invalidState',
  Type.Object(
    {
      scopeId: ScopeIdSchema,
      authoredNodeId: AuthoredNodeIdSchema,
      nodeInstanceId: NodeInstanceIdSchema,
      errorCode: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
);
const pipelineBranchDefaulted = eventVariant('pipeline.branchDefaulted', NodeIdentitySchema);
const parallelJoinFailed = eventVariant('parallel.joinFailed', NodeIdentitySchema);
const subpipelineFailed = eventVariant('subpipeline.failed', NodeIdentitySchema);
const delayCancelled = eventVariant('delay.cancelled', NodeIdentitySchema);
const humanGateConflict = eventVariant('humanGate.conflict', NodeIdentitySchema);
const humanGateTimedOut = eventVariant('humanGate.timedOut', NodeIdentitySchema);
const humanGateCancelled = eventVariant('humanGate.cancelled', NodeIdentitySchema);
const consensusRejected = eventVariant('consensus.rejected', NodeIdentitySchema);
const consensusInsufficientQuorum = eventVariant(
  'consensus.insufficientQuorum',
  NodeIdentitySchema,
);
const consensusTimedOut = eventVariant('consensus.timedOut', NodeIdentitySchema);
const consensusDuplicateParticipant = eventVariant(
  'consensus.duplicateParticipantResultRejected',
  NodeIdentitySchema,
);
const consensusParticipantFailed = eventVariant('consensus.participantFailed', NodeIdentitySchema);
const consensusUnknownParticipant = eventVariant(
  'consensus.unknownParticipantRejected',
  Type.Object(
    {
      scopeId: ScopeIdSchema,
      authoredNodeId: AuthoredNodeIdSchema,
      nodeInstanceId: NodeInstanceIdSchema,
      participantId: IdentifierSchema,
    },
    { additionalProperties: false },
  ),
);
const repeatExhausted = eventVariant('repeat.exhausted', NodeIdentitySchema);
const mapLimitExceeded = eventVariant('map.limitExceeded', NodeIdentitySchema);
const runCompleted = eventVariant(
  'run.completed',
  Type.Object({ outcome: IdentifierSchema }, { additionalProperties: false }),
);
const runFailed = eventVariant(
  'run.failed',
  Type.Object({ outcome: IdentifierSchema }, { additionalProperties: false }),
);
const runCommandAccepted = eventVariant('runCommand.accepted', RunCommandAcceptedMetadataSchema);
const runCommandRejected = eventVariant('runCommand.rejected', RunCommandRejectedMetadataSchema);

export const PipelineEventDraftSchema = Type.Union([
  nodeExecutionStarted.draft,
  nodeExecutionCompleted.draft,
  nodeExecutionFailed.draft,
  nodeExecutionRecoveryExhausted.draft,
  nodeExecutionTimedOut.draft,
  nodeExecutionCancelled.draft,
  inputResolutionFailed.draft,
  pipelineInvalidState.draft,
  pipelineBranchDefaulted.draft,
  parallelJoinFailed.draft,
  subpipelineFailed.draft,
  delayCancelled.draft,
  repeatExhausted.draft,
  mapLimitExceeded.draft,
]);

export const RunEventDraftSchema = Type.Union([
  nodeExecutionStarted.draft,
  nodeExecutionCompleted.draft,
  nodeExecutionFailed.draft,
  nodeExecutionRecoveryExhausted.draft,
  nodeExecutionTimedOut.draft,
  nodeExecutionCancelled.draft,
  inputResolutionFailed.draft,
  pipelineInvalidState.draft,
  pipelineBranchDefaulted.draft,
  parallelJoinFailed.draft,
  subpipelineFailed.draft,
  delayCancelled.draft,
  humanGateConflict.draft,
  humanGateTimedOut.draft,
  humanGateCancelled.draft,
  consensusRejected.draft,
  consensusInsufficientQuorum.draft,
  consensusTimedOut.draft,
  consensusDuplicateParticipant.draft,
  consensusParticipantFailed.draft,
  consensusUnknownParticipant.draft,
  repeatExhausted.draft,
  mapLimitExceeded.draft,
  runCompleted.draft,
  runFailed.draft,
  runCommandAccepted.draft,
  runCommandRejected.draft,
]);

export const RunEventSchema = Type.Union([
  nodeExecutionStarted.stored,
  nodeExecutionCompleted.stored,
  nodeExecutionFailed.stored,
  nodeExecutionRecoveryExhausted.stored,
  nodeExecutionTimedOut.stored,
  nodeExecutionCancelled.stored,
  inputResolutionFailed.stored,
  pipelineInvalidState.stored,
  pipelineBranchDefaulted.stored,
  parallelJoinFailed.stored,
  subpipelineFailed.stored,
  delayCancelled.stored,
  humanGateConflict.stored,
  humanGateTimedOut.stored,
  humanGateCancelled.stored,
  consensusRejected.stored,
  consensusInsufficientQuorum.stored,
  consensusTimedOut.stored,
  consensusDuplicateParticipant.stored,
  consensusParticipantFailed.stored,
  consensusUnknownParticipant.stored,
  repeatExhausted.stored,
  mapLimitExceeded.stored,
  runCompleted.stored,
  runFailed.stored,
  runCommandAccepted.stored,
  runCommandRejected.stored,
]);

export type PipelineEventDraft = DeepReadonly<Type.Static<typeof PipelineEventDraftSchema>>;
export type RunEventDraft = DeepReadonly<Type.Static<typeof RunEventDraftSchema>>;
export type RunEvent = DeepReadonly<Type.Static<typeof RunEventSchema>>;
