import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
} from '../schema-primitives.js';
import { RunWorkflowResultSchema } from './run-workflow-result.js';
import { TerminalWorkflowResultSchema } from './terminal-workflow-result.js';

const MapItemIdentitySchema = {
  sourceIndex: NonNegativeIntegerSchema,
  itemKey: NonEmptyStringSchema,
};

const ContinuedMapItemResultSchema = Type.Object(
  {
    kind: Type.Literal('continued'),
    ...MapItemIdentitySchema,
    outcome: IdentifierSchema,
    output: Type.Optional(NodeOutputSchema),
  },
  { additionalProperties: false },
);

const AuthoredEndMapItemResultSchema = Type.Object(
  {
    kind: Type.Literal('authoredEnd'),
    ...MapItemIdentitySchema,
    result: RunWorkflowResultSchema,
  },
  { additionalProperties: false },
);

const TerminalMapItemResultSchema = Type.Object(
  {
    kind: Type.Literal('terminal'),
    ...MapItemIdentitySchema,
    result: TerminalWorkflowResultSchema,
  },
  { additionalProperties: false },
);

const SettlementOnlyMapItemResultSchema = Type.Object(
  { kind: Type.Literal('settlementOnly'), ...MapItemIdentitySchema },
  { additionalProperties: false },
);

export const MapItemResultSchema = Type.Union([
  ContinuedMapItemResultSchema,
  AuthoredEndMapItemResultSchema,
  TerminalMapItemResultSchema,
  SettlementOnlyMapItemResultSchema,
]);

export type MapItemResult = DeepReadonly<Type.Static<typeof MapItemResultSchema>>;
