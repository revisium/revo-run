import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { JsonValueSchema } from '../json-value.js';
import { IdentifierSchema, NonEmptyStringSchema } from '../schema-primitives.js';
import { CompiledPipelineSchema } from './compiled-pipeline.js';
import { NodeOutputSchema } from './node-output.js';
import { RunNodePathSchema } from './node-path.js';
import { PipelineProgressSchema } from './pipeline-progress.js';

export const PipelineActionSourceSchema = Type.Object(
  {
    nodePath: RunNodePathSchema,
    outcome: IdentifierSchema,
  },
  { additionalProperties: false },
);

export type PipelineActionSource = DeepReadonly<Type.Static<typeof PipelineActionSourceSchema>>;

export const PipelineProgressErrorSchema = Type.Object(
  {
    code: IdentifierSchema,
    path: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type PipelineProgressError = DeepReadonly<Type.Static<typeof PipelineProgressErrorSchema>>;

export const PipelineActionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('activateNodes'),
      source: Type.Union([Type.Literal('entry'), PipelineActionSourceSchema]),
      nodePaths: Type.Array(RunNodePathSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('cancelNodes'),
      source: PipelineActionSourceSchema,
      nodePaths: Type.Array(RunNodePathSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('wait'),
      nodePaths: Type.Array(RunNodePathSchema),
      reason: Type.Union([
        Type.Literal('consensus'),
        Type.Literal('delay'),
        Type.Literal('join'),
        Type.Literal('nodeExecution'),
        Type.Literal('subpipeline'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('finishPipeline'),
      status: Type.Union([
        Type.Literal('cancelled'),
        Type.Literal('failed'),
        Type.Literal('succeeded'),
      ]),
      outcome: IdentifierSchema,
      output: Type.Optional(NodeOutputSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('invalidPipelineState'),
      errors: Type.Array(PipelineProgressErrorSchema),
    },
    { additionalProperties: false },
  ),
]);

export type PipelineAction = DeepReadonly<Type.Static<typeof PipelineActionSchema>>;

export const PipelineDecisionInputSchema = Type.Object(
  {
    pipelines: Type.Record(IdentifierSchema, CompiledPipelineSchema, {
      additionalProperties: false,
      minProperties: 1,
    }),
    pipelineId: IdentifierSchema,
    pipelineInstancePath: RunNodePathSchema,
    runInput: JsonValueSchema,
    pipelineInput: JsonValueSchema,
    progress: PipelineProgressSchema,
  },
  { additionalProperties: false },
);

export type PipelineDecisionInput = DeepReadonly<Type.Static<typeof PipelineDecisionInputSchema>>;

export type GetNextPipelineAction = (input: PipelineDecisionInput) => PipelineAction;
