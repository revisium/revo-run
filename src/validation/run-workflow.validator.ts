import Schema from 'typebox/schema';

import {
  RunWorkflowArgumentsSchema,
  RunWorkflowInputSchema,
} from '../contracts/workflow/run-workflow-input.js';
import { RunWorkflowResultSchema } from '../contracts/workflow/run-workflow-result.js';

export const RunWorkflowInputValidator = Schema.Compile(RunWorkflowInputSchema);
export const RunWorkflowArgumentsValidator = Schema.Compile(RunWorkflowArgumentsSchema);
export const RunWorkflowResultValidator = Schema.Compile(RunWorkflowResultSchema);
