import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeInstanceIdSchema, ScopeIdSchema } from '../execution-identity.js';
import { ConsensusVoteLiteralSchema } from '../pipeline/consensus-vote.js';
import { IdentifierSchema, NonEmptyStringSchema } from '../schema-primitives.js';

export const ConsensusVerdictNameSchema = Type.Union([
  Type.Literal('approved'),
  Type.Literal('rejected'),
  Type.Literal('insufficientQuorum'),
  Type.Literal('timedOut'),
  Type.Literal('failed'),
]);

export const AcceptedConsensusVoteSchema = Type.Object(
  {
    participantId: IdentifierSchema,
    vote: ConsensusVoteLiteralSchema,
    executionId: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const DurableConsensusVerdictSchema = Type.Object(
  {
    kind: Type.Literal('consensusVerdict'),
    scopeId: ScopeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
    verdict: ConsensusVerdictNameSchema,
    remaining: Type.Union([Type.Literal('cancel'), Type.Literal('drain')]),
    acceptedVotes: Type.Array(AcceptedConsensusVoteSchema),
    failedParticipantIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    invalidParticipantIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    remainingParticipantIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export type ConsensusVerdictName = DeepReadonly<Type.Static<typeof ConsensusVerdictNameSchema>>;
export type AcceptedConsensusVote = DeepReadonly<Type.Static<typeof AcceptedConsensusVoteSchema>>;
export type DurableConsensusVerdict = DeepReadonly<
  Type.Static<typeof DurableConsensusVerdictSchema>
>;
