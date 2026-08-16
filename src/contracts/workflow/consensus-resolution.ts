import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { DurableConsensusVerdictSchema } from './consensus-verdict.js';

export const ConsensusResolutionDirectiveSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('decided'), verdict: DurableConsensusVerdictSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('cancel') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('fail') }, { additionalProperties: false }),
]);

export type ConsensusResolutionDirective = DeepReadonly<
  Type.Static<typeof ConsensusResolutionDirectiveSchema>
>;
