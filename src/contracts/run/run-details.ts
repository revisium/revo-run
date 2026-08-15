import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  NodeInstanceIdSchema,
  ScopeIdSchema,
  type AttemptId,
  type AuthoredNodeId,
  type NodeInstanceId,
  type ScopeId,
} from '../execution-identity.js';
import { MapSummarySchema } from '../pipeline/map-output.js';
import type { NodeOutput } from '../pipeline/node-output.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
} from '../schema-primitives.js';
import type { CommandId, RunCommandRejectionReason } from './run-command.js';
import type { RunSnapshot } from './run.js';

export type RunNodeExecutionStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'outcomeUnknown'
  | 'timedOut';

export const ParallelJoinObservationSchema = Type.Object(
  {
    scopeId: ScopeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
    outcome: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
    remaining: Type.Union([Type.Literal('cancel'), Type.Literal('drain')]),
    observedBranchKeys: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
    outputEligibleBranchKeys: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
    skippedBranchKeys: Type.Array(IdentifierSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export type ParallelJoinObservation = DeepReadonly<
  Type.Static<typeof ParallelJoinObservationSchema>
>;

export const SkippedParallelBranchSchema = Type.Object(
  {
    kind: Type.Literal('parallelBranch'),
    disposition: Type.Literal('skipped'),
    reason: Type.Literal('join-decided'),
    scopeId: ScopeIdSchema,
    parentScopeId: ScopeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
    branchKey: IdentifierSchema,
  },
  { additionalProperties: false },
);

export type SkippedParallelBranch = DeepReadonly<Type.Static<typeof SkippedParallelBranchSchema>>;

const MapExecutionIdentitySchema = {
  scopeId: ScopeIdSchema,
  nodeInstanceId: NodeInstanceIdSchema,
  summary: MapSummarySchema,
};

export const MapExecutionObservationSchema = Type.Union([
  Type.Object(
    {
      ...MapExecutionIdentitySchema,
      outcome: Type.Union([Type.Literal('completed'), Type.Literal('completedWithErrors')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...MapExecutionIdentitySchema,
      outcome: Type.Literal('failed'),
      remaining: Type.Union([Type.Literal('cancel'), Type.Literal('drain')]),
      decisiveItemKey: NonEmptyStringSchema,
    },
    { additionalProperties: false },
  ),
]);

export type MapExecutionObservation = DeepReadonly<
  Type.Static<typeof MapExecutionObservationSchema>
>;

export const SkippedMapItemSchema = Type.Object(
  {
    mapNodeInstanceId: NodeInstanceIdSchema,
    sourceIndex: NonNegativeIntegerSchema,
    itemKey: NonEmptyStringSchema,
    scopeId: ScopeIdSchema,
  },
  { additionalProperties: false },
);

export type SkippedMapItem = DeepReadonly<Type.Static<typeof SkippedMapItemSchema>>;

interface RunWorkflowScopeBase {
  readonly id: ScopeId;
  readonly pipelineId: string;
  readonly displayPath: string;
  readonly status: import('./run.js').RunStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
}

export type RunScope =
  | (RunWorkflowScopeBase & { readonly kind: 'root' })
  | (RunWorkflowScopeBase & {
      readonly kind: 'parallelBranch';
      readonly parentScopeId: ScopeId;
    })
  | (RunWorkflowScopeBase & {
      readonly kind: 'repeatIteration';
      readonly parentScopeId: ScopeId;
      readonly ordinal: number;
    })
  | (RunWorkflowScopeBase & {
      readonly kind: 'mapItem';
      readonly parentScopeId: ScopeId;
      readonly mapNodeInstanceId: NodeInstanceId;
      readonly sourceIndex: number;
      readonly itemKey: string;
      readonly disposition: 'execute' | 'settlementOnly';
    })
  | {
      readonly kind: 'inlineSubpipeline';
      readonly id: ScopeId;
      readonly parentScopeId: ScopeId;
      readonly pipelineId: string;
      readonly displayPath: string;
    };

export interface RunNodeInstance {
  readonly id: NodeInstanceId;
  readonly scopeId: ScopeId;
  readonly authoredNodeId: AuthoredNodeId;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly displayPath: string;
  readonly status: RunNodeExecutionStatus;
  readonly attemptIds: readonly AttemptId[];
  readonly startedAt?: Date;
  readonly completedAt?: Date;
}

interface RunAttemptBase {
  readonly id: AttemptId;
  readonly nodeInstanceId: NodeInstanceId;
  readonly ordinal: number;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
}

export type RunAttempt =
  | (RunAttemptBase & {
      readonly status: 'completed';
      readonly outcome: string;
      readonly output?: NodeOutput;
    })
  | (RunAttemptBase & {
      readonly status: 'failed';
      readonly error: { readonly code: string };
    })
  | (RunAttemptBase & {
      readonly status: 'outcomeUnknown';
      readonly recovery: { readonly reconciliationRound: number };
    })
  | (RunAttemptBase & { readonly status: 'timedOut' })
  | (RunAttemptBase & { readonly status: 'cancelled' });

export interface RunDetails {
  readonly run: RunSnapshot;
  readonly scopes: readonly RunScope[];
  readonly nodeInstances: readonly RunNodeInstance[];
  readonly attempts: readonly RunAttempt[];
  readonly commands: readonly RunCommandDetails[];
  readonly parallelJoins: readonly ParallelJoinObservation[];
  readonly skippedParallelBranches: readonly SkippedParallelBranch[];
  readonly mapExecutions: readonly MapExecutionObservation[];
  readonly skippedMapItems: readonly SkippedMapItem[];
}

interface RunCommandDetailsBase {
  readonly commandId: CommandId;
  readonly commandKind: 'cancelRun' | 'resolveUnknownOutcome' | 'answerGate';
  readonly actorId?: string;
  readonly targetAttemptId?: AttemptId;
}

export type RunCommandDetails = RunCommandDetailsBase &
  (
    | { readonly decision: 'accepted' }
    | { readonly decision: 'rejected'; readonly reason: RunCommandRejectionReason }
  ) & {
    readonly resolution?: {
      readonly kind: 'adoptSuccess' | 'markFailed' | 'retry';
      readonly outcome?: string;
    };
  };
