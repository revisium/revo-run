import Schema from 'typebox/schema';

import { RunWorkflowArgumentsSchema } from '../contracts/workflow/run-workflow-input.js';
import { RunWorkflowResultSchema } from '../contracts/workflow/run-workflow-result.js';

export const RunWorkflowArgumentsValidator = Schema.Compile(RunWorkflowArgumentsSchema);
export const RunWorkflowResultValidator = Schema.Compile(RunWorkflowResultSchema);

export const RunWorkflowArgumentsParser = {
  parse(value: unknown): unknown {
    if (!RunWorkflowArgumentsValidator.Check(value)) {
      throw new Error('Run workflow input is invalid.');
    }

    return value;
  },
};
