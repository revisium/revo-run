import Type from 'typebox';

import { NonEmptyStringSchema, PipelineNodePathSchema } from '../schema-primitives.js';

export type PipelineNodePath = Type.Static<typeof PipelineNodePathSchema>;

export const RunNodePathSchema = NonEmptyStringSchema;

export type RunNodePath = Type.Static<typeof RunNodePathSchema>;
