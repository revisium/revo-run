import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeInstanceIdSchema, ScopeIdSchema } from '../execution-identity.js';
import { IdentifierSchema } from '../schema-primitives.js';

const SettlementSchema = Type.Object(
  { key: IdentifierSchema, outcome: IdentifierSchema },
  { additionalProperties: false },
);

export const DurableParallelJoinDecisionSchema = Type.Object(
  {
    kind: Type.Literal('parallelJoinDecision'),
    scopeId: ScopeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
    outcome: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
    remaining: Type.Union([Type.Literal('cancel'), Type.Literal('drain')]),
    settlements: Type.Array(SettlementSchema, { minItems: 1 }),
    outputEligibleBranchKeys: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
    skippedBranchKeys: Type.Array(IdentifierSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export type DurableParallelJoinDecision = DeepReadonly<
  Type.Static<typeof DurableParallelJoinDecisionSchema>
>;
