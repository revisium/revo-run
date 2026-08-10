import Type from 'typebox';

import type { DeepReadonly } from './deep-readonly.js';

const digestPattern = '[A-Za-z0-9_-]{43}';

export const AuthoredNodeIdSchema = Type.String({ pattern: `^an1_${digestPattern}$` });
export const ScopeIdSchema = Type.String({ pattern: `^sc1_${digestPattern}$` });
export const NodeInstanceIdSchema = Type.String({ pattern: `^ni1_${digestPattern}$` });
export const AttemptIdSchema = Type.String({ pattern: `^at1_${digestPattern}$` });
export const ScopeWorkflowIdSchema = Type.String({
  pattern: `^rr:scope:v2:sc1_${digestPattern}$`,
});

export type AttemptId = DeepReadonly<Type.Static<typeof AttemptIdSchema>>;
export type ScopeWorkflowId = DeepReadonly<Type.Static<typeof ScopeWorkflowIdSchema>>;
