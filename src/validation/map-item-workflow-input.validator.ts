import {
  MapItemWorkflowArgumentsSchema,
  MapItemWorkflowInputSchema,
  type MapItemWorkflowInput,
} from '../contracts/workflow/map-item-workflow-input.js';
import {
  durableWorkflowInputValidator,
  type DurableWorkflowInputValidator,
} from './workflow-input-validator.js';

const validator: DurableWorkflowInputValidator<MapItemWorkflowInput> =
  durableWorkflowInputValidator(
    MapItemWorkflowInputSchema,
    MapItemWorkflowArgumentsSchema,
    'Map item workflow input is invalid.',
  );

export const parseMapItemWorkflowInput = (value: unknown): MapItemWorkflowInput =>
  validator.parse(value);

export const MapItemWorkflowArgumentsParser = validator.argumentsParser;
