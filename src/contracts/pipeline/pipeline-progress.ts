import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { IdentifierSchema, NonEmptyStringSchema } from '../schema-primitives.js';
import { NodeOutputSchema } from './node-output.js';
import { RunNodePathSchema } from './node-path.js';

export const NodeProgressSchema = Type.Union([
  Type.Object(
    {
      nodePath: RunNodePathSchema,
      status: Type.Literal('active'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      nodePath: RunNodePathSchema,
      status: Type.Literal('settled'),
      outcome: IdentifierSchema,
      output: Type.Optional(NodeOutputSchema),
    },
    { additionalProperties: false },
  ),
]);

export type NodeProgress = DeepReadonly<Type.Static<typeof NodeProgressSchema>>;

export const ConsensusVoteSchema = Type.Object(
  {
    nodePath: RunNodePathSchema,
    participantId: IdentifierSchema,
    vote: Type.Union([Type.Literal('abstain'), Type.Literal('approve'), Type.Literal('reject')]),
    executionId: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type ConsensusVote = DeepReadonly<Type.Static<typeof ConsensusVoteSchema>>;

export const ReachedDeadlineSchema = Type.Object(
  {
    nodePath: RunNodePathSchema,
    kind: Type.Union([Type.Literal('consensus'), Type.Literal('delay')]),
  },
  { additionalProperties: false },
);

export type ReachedDeadline = DeepReadonly<Type.Static<typeof ReachedDeadlineSchema>>;

export const PipelineProgressSchema = Type.Object(
  {
    nodes: Type.Array(NodeProgressSchema),
    consensusVotes: Type.Array(ConsensusVoteSchema),
    reachedDeadlines: Type.Array(ReachedDeadlineSchema),
  },
  { additionalProperties: false },
);

export type PipelineProgress = DeepReadonly<Type.Static<typeof PipelineProgressSchema>>;
