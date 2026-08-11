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

const cursorPattern = '^[A-Za-z][A-Za-z0-9._-]{0,127}:[1-9][0-9]*$';
const timestampPattern = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

const CursorSchema = Type.String({ pattern: cursorPattern });
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
      cursor: CursorSchema,
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
const nodeExecutionTimedOut = eventVariant('nodeExecution.timedOut', AttemptIdentitySchema);
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
const runCompleted = eventVariant(
  'run.completed',
  Type.Object({ outcome: IdentifierSchema }, { additionalProperties: false }),
);
const runFailed = eventVariant(
  'run.failed',
  Type.Object({ outcome: IdentifierSchema }, { additionalProperties: false }),
);

export const PipelineEventDraftSchema = Type.Union([
  nodeExecutionStarted.draft,
  nodeExecutionCompleted.draft,
  nodeExecutionFailed.draft,
  nodeExecutionTimedOut.draft,
  inputResolutionFailed.draft,
  pipelineInvalidState.draft,
  pipelineBranchDefaulted.draft,
  parallelJoinFailed.draft,
  subpipelineFailed.draft,
]);

export const RunEventDraftSchema = Type.Union([
  nodeExecutionStarted.draft,
  nodeExecutionCompleted.draft,
  nodeExecutionFailed.draft,
  nodeExecutionTimedOut.draft,
  inputResolutionFailed.draft,
  pipelineInvalidState.draft,
  pipelineBranchDefaulted.draft,
  parallelJoinFailed.draft,
  subpipelineFailed.draft,
  runCompleted.draft,
  runFailed.draft,
]);

export const RunEventSchema = Type.Union([
  nodeExecutionStarted.stored,
  nodeExecutionCompleted.stored,
  nodeExecutionFailed.stored,
  nodeExecutionTimedOut.stored,
  inputResolutionFailed.stored,
  pipelineInvalidState.stored,
  pipelineBranchDefaulted.stored,
  parallelJoinFailed.stored,
  subpipelineFailed.stored,
  runCompleted.stored,
  runFailed.stored,
]);

export type PipelineEventDraft = DeepReadonly<Type.Static<typeof PipelineEventDraftSchema>>;
export type RunEventDraft = DeepReadonly<Type.Static<typeof RunEventDraftSchema>>;
export type RunEvent = DeepReadonly<Type.Static<typeof RunEventSchema>>;
