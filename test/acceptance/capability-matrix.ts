import { coordinationScenarios } from './scenarios/coordination.scenarios.js';
import { enterpriseScenarios } from './scenarios/enterprise.scenarios.js';
import { executionScenarios } from './scenarios/execution.scenarios.js';

export const plannedPipelineScenarios = [
  ...executionScenarios,
  ...coordinationScenarios,
  ...enterpriseScenarios,
] as const;
