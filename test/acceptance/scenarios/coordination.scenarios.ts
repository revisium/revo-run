import { branchScenarios } from './branch.scenarios.js';
import { consensusScenarios } from './consensus.scenarios.js';
import { humanGateScenarios } from './human-gate.scenarios.js';
import { parallelScenarios } from './parallel.scenarios.js';
import { repeatScenarios } from './repeat.scenarios.js';
import { subpipelineScenarios } from './subpipeline.scenarios.js';

export const coordinationScenarios = [
  ...branchScenarios,
  ...parallelScenarios,
  ...consensusScenarios,
  ...humanGateScenarios,
  ...subpipelineScenarios,
  ...repeatScenarios,
] as const;
