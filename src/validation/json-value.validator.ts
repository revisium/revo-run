import Schema from 'typebox/schema';

import { JsonValueSchema } from '../contracts/json-value.js';

export const JsonValueValidator = Schema.Compile(JsonValueSchema);
