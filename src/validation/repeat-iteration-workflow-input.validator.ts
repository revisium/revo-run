import {
  RepeatIterationWorkflowArgumentsSchema,
  RepeatIterationWorkflowInputSchema,
  type RepeatIterationWorkflowInput,
} from '../contracts/workflow/repeat-iteration-workflow-input.js';
import {
  durableWorkflowInputValidator,
  type DurableWorkflowInputValidator,
} from './workflow-input-validator.js';

const validator: DurableWorkflowInputValidator<RepeatIterationWorkflowInput> =
  durableWorkflowInputValidator(
    RepeatIterationWorkflowInputSchema,
    RepeatIterationWorkflowArgumentsSchema,
    'Repeat iteration workflow input is invalid.',
  );

export const parseRepeatIterationWorkflowInput = (value: unknown): RepeatIterationWorkflowInput =>
  validator.parse(value);

export const RepeatIterationWorkflowArgumentsParser = validator.argumentsParser;
