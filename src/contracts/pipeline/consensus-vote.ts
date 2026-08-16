import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { IdentifierSchema, NonEmptyStringSchema } from '../schema-primitives.js';
import { RunNodePathSchema } from './node-path.js';

export const ConsensusVoteLiteralSchema = Type.Union([
  Type.Literal('abstain'),
  Type.Literal('approve'),
  Type.Literal('reject'),
]);

export const ConsensusVoteSchema = Type.Object(
  {
    nodePath: RunNodePathSchema,
    participantId: IdentifierSchema,
    vote: ConsensusVoteLiteralSchema,
    executionId: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type ConsensusVote = DeepReadonly<Type.Static<typeof ConsensusVoteSchema>>;
export type ConsensusVoteLiteral = DeepReadonly<Type.Static<typeof ConsensusVoteLiteralSchema>>;
