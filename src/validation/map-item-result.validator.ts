import Schema from 'typebox/schema';

import { MapItemResultSchema, type MapItemResult } from '../contracts/workflow/map-item-result.js';

const validator = Schema.Compile(MapItemResultSchema);

export const parseMapItemResult = (value: unknown): MapItemResult => {
  if (!validator.Check(value)) {
    throw new Error('Map item workflow result is invalid.');
  }
  return value;
};
