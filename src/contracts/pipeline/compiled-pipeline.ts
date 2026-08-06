import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { PipelineNodeSchema } from './pipeline-node.schema.js';

export const CompiledPipelineSchema = Type.Object(
  { root: PipelineNodeSchema },
  { additionalProperties: false },
);

export type CompiledPipeline = DeepReadonly<Type.Static<typeof CompiledPipelineSchema>>;
