import Schema from 'typebox/schema';

import { NodeOutputSchema } from '../contracts/pipeline/node-output.js';

export const NodeOutputValidator = Schema.Compile(NodeOutputSchema);
