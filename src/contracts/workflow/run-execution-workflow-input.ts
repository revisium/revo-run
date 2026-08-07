import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NonEmptyStringSchema } from '../schema-primitives.js';

export const RunExecutionWorkflowInputSchema = Type.Object(
  { runId: NonEmptyStringSchema },
  { additionalProperties: false },
);

export const RunExecutionWorkflowArgumentsSchema = Type.Tuple([RunExecutionWorkflowInputSchema]);

export type RunExecutionWorkflowInput = DeepReadonly<
  Type.Static<typeof RunExecutionWorkflowInputSchema>
>;
