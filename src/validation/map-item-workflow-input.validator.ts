import Schema from 'typebox/schema';

import {
  MapItemWorkflowArgumentsSchema,
  MapItemWorkflowInputSchema,
  type MapItemWorkflowInput,
} from '../contracts/workflow/map-item-workflow-input.js';

const validator = Schema.Compile(MapItemWorkflowInputSchema);
const argumentsValidator = Schema.Compile(MapItemWorkflowArgumentsSchema);

const invalidInput = (): Error => new Error('Map item workflow input is invalid.');

export const MapItemWorkflowArgumentsParser = {
  parse(value: unknown): unknown {
    if (!argumentsValidator.Check(value)) {
      throw invalidInput();
    }
    return value;
  },
};

export const parseMapItemWorkflowInput = (value: unknown): MapItemWorkflowInput => {
  if (!validator.Check(value)) {
    throw invalidInput();
  }
  return value;
};
