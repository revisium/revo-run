import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeInstanceIdSchema, ScopeIdSchema } from '../execution-identity.js';
import { NonEmptyStringSchema, NonNegativeIntegerSchema } from '../schema-primitives.js';

const MapDecisionItemSchema = Type.Object(
  { sourceIndex: NonNegativeIntegerSchema, itemKey: NonEmptyStringSchema },
  { additionalProperties: false },
);

const RemainingMapDecisionItemSchema = Type.Object(
  {
    sourceIndex: NonNegativeIntegerSchema,
    itemKey: NonEmptyStringSchema,
    disposition: Type.Union([Type.Literal('cancel'), Type.Literal('drain')]),
  },
  { additionalProperties: false },
);

const MapDecisionIdentitySchema = {
  scopeId: ScopeIdSchema,
  nodeInstanceId: NodeInstanceIdSchema,
  summaryEligibleItemKeys: Type.Array(NonEmptyStringSchema, { uniqueItems: true }),
  admitted: Type.Array(MapDecisionItemSchema, { uniqueItems: true }),
  remaining: Type.Array(RemainingMapDecisionItemSchema, { uniqueItems: true }),
};

const AllSettledMapControlDecisionSchema = Type.Object(
  { ...MapDecisionIdentitySchema, control: Type.Literal('allSettled') },
  { additionalProperties: false },
);

const FailureMapControlDecisionSchema = Type.Object(
  {
    ...MapDecisionIdentitySchema,
    control: Type.Literal('failureDecided'),
    decisiveItemKey: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export const DurableMapControlDecisionSchema = Type.Union([
  AllSettledMapControlDecisionSchema,
  FailureMapControlDecisionSchema,
]);

export type DurableMapControlDecision = DeepReadonly<
  Type.Static<typeof DurableMapControlDecisionSchema>
>;
