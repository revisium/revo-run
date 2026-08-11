import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import type { JsonValue } from '../json-value.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { IdentifierSchema } from '../schema-primitives.js';
import type { ExecutionPlan } from './execution-plan.js';
import type { RunId } from './run-id.js';

// RunSnapshot is an in-memory manager view, not a durable JSON contract. Serialized API models
// must define their own timestamp representation and schema instead of reusing this Date-based view.
export const RunStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

export type RunStatus = DeepReadonly<Type.Static<typeof RunStatusSchema>>;

export const RunErrorSchema = Type.Union([
  Type.Object(
    {
      code: Type.Literal('workflow_failed'),
      message: Type.Literal('Workflow execution failed.'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Type.Literal('recovery_exhausted'),
      message: Type.Literal('Workflow recovery attempts were exhausted.'),
    },
    { additionalProperties: false },
  ),
]);

export type RunError = DeepReadonly<Type.Static<typeof RunErrorSchema>>;

export const RunResultSchema = Type.Object(
  {
    outcome: IdentifierSchema,
    output: Type.Optional(NodeOutputSchema),
  },
  { additionalProperties: false },
);

export type RunResult = DeepReadonly<Type.Static<typeof RunResultSchema>>;

interface RunBase {
  readonly id: RunId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type RunSummary =
  | (RunBase & { readonly status: 'pending' | 'running' })
  | (RunBase & { readonly status: 'succeeded'; readonly result: RunResult })
  | (RunBase & { readonly status: 'failed'; readonly result: RunResult })
  | (RunBase & { readonly status: 'failed'; readonly error: RunError })
  | (RunBase & { readonly status: 'cancelled'; readonly result?: RunResult });

export type RunSnapshot = RunSummary & {
  readonly executionPlan: ExecutionPlan;
  readonly input: JsonValue;
};
