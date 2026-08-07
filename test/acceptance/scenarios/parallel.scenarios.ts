import { parallelCancelScenarios } from './parallel/cancel.scenarios.js';
import { parallelCompositionScenarios } from './parallel/composition.scenarios.js';
import { parallelJoinScenarios } from './parallel/join.scenarios.js';

export const parallelDrainScenarios = [
  ...parallelJoinScenarios,
  ...parallelCompositionScenarios,
] as const;

export const parallelScenarios = [...parallelDrainScenarios, ...parallelCancelScenarios] as const;
