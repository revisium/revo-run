import { branchScenarios } from './scenarios/branch.scenarios.js';
import { dataReferenceFailureScenarios } from './scenarios/data-reference-failure.scenarios.js';
import { dataReferenceScenarios } from './scenarios/data-reference.scenarios.js';
import { executionValidationScenarios } from './scenarios/execution-validation.scenarios.js';
import { subpipelineScenarios } from './scenarios/subpipeline.scenarios.js';

export const implementedPipelineScenarios = [
  ...branchScenarios,
  ...subpipelineScenarios,
  ...dataReferenceScenarios,
  ...dataReferenceFailureScenarios,
  ...executionValidationScenarios,
] as const;
