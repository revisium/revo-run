import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { ScopeIdSchema } from '../execution-identity.js';
import { RunIdSchema } from '../run/run-id.js';

export const RunExecutionWorkflowInputSchema = Type.Object(
  {
    runId: RunIdSchema,
    scopeId: ScopeIdSchema,
  },
  { additionalProperties: false },
);

export const RunExecutionWorkflowArgumentsSchema = Type.Tuple([RunExecutionWorkflowInputSchema]);

export type RunExecutionWorkflowInput = DeepReadonly<
  Type.Static<typeof RunExecutionWorkflowInputSchema>
>;
