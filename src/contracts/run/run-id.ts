import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';

export const RunIdSchema = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9._-]{0,127}$' });

export type RunId = DeepReadonly<Type.Static<typeof RunIdSchema>>;
