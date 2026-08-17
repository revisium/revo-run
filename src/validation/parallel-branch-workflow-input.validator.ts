import {
  ParallelBranchWorkflowArgumentsSchema,
  ParallelBranchWorkflowInputSchema,
  type ParallelBranchWorkflowInput,
} from '../contracts/workflow/parallel-branch-workflow-input.js';
import {
  durableWorkflowInputValidator,
  type DurableWorkflowInputValidator,
} from './workflow-input-validator.js';

const validator: DurableWorkflowInputValidator<ParallelBranchWorkflowInput> =
  durableWorkflowInputValidator(
    ParallelBranchWorkflowInputSchema,
    ParallelBranchWorkflowArgumentsSchema,
    'Parallel branch workflow input is invalid.',
  );

export const parseParallelBranchWorkflowInput = (value: unknown): ParallelBranchWorkflowInput =>
  validator.parse(value);

export const ParallelBranchWorkflowArgumentsParser = validator.argumentsParser;
