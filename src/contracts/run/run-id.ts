import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';

export const runIdPattern = '^[A-Za-z][A-Za-z0-9._-]{0,127}$';
export const RunIdSchema = Type.String({ pattern: runIdPattern });

export type RunId = DeepReadonly<Type.Static<typeof RunIdSchema>>;
