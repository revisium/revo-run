import {
  RunExecutionWorkflowArgumentsSchema,
  RunExecutionWorkflowInputSchema,
  type RunExecutionWorkflowInput,
} from '../contracts/workflow/run-execution-workflow-input.js';
import {
  durableWorkflowInputValidator,
  type DurableWorkflowInputValidator,
} from './workflow-input-validator.js';

const validator: DurableWorkflowInputValidator<RunExecutionWorkflowInput> =
  durableWorkflowInputValidator(
    RunExecutionWorkflowInputSchema,
    RunExecutionWorkflowArgumentsSchema,
    'Run execution workflow input is invalid.',
  );

export const parseRunExecutionWorkflowInput = (value: unknown): RunExecutionWorkflowInput =>
  validator.parse(value);

export const RunExecutionWorkflowArgumentsParser = validator.argumentsParser;
