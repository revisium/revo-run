import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { ConsensusVoteSchema } from '../pipeline/consensus-vote.js';
import { IdentifierSchema } from '../schema-primitives.js';

export const ParticipantSettlementSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('voted'), vote: ConsensusVoteSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('completedWithoutVote'), outcome: IdentifierSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('executionFailed') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('timedOut') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('cancelled') }, { additionalProperties: false }),
]);

export type ParticipantSettlement = DeepReadonly<Type.Static<typeof ParticipantSettlementSchema>>;
