import type { RunScenario, ScenarioCapability } from '../dsl/run-scenario.js';
import { plannedPipelineScenarios } from './capability-matrix.js';

export const implementedCapabilities = [
  'agentTaskExecution',
  'artifactOutput',
  'artifactReferenceDataFlow',
  'bindingTargetValidation',
  'boundedRepeatValidation',
  'branchDefaultValidation',
  'composedExecutionBoundValidation',
  'consensusThresholdValidation',
  'defaultOutcomeBranch',
  'duplicateTaskBindingValidation',
  'entityReferenceInput',
  'inertReferenceShapedJson',
  'identifierValidation',
  'missingEntityVersionFailure',
  'missingJsonPointerFailure',
  'missingOutputKeyFailure',
  'missingSubpipelineValidation',
  'nestedParallelExecution',
  'nodeOutputDataFlow',
  'outcomeBranchSelection',
  'ownPropertyOutcomeRouting',
  'parallelAllJoin',
  'parallelAllJoinFailure',
  'parallelAnyJoin',
  'parallelAnyJoinFailure',
  'parallelBranchComposition',
  'parallelBranchDrain',
  'parallelInputFailure',
  'parallelOutputDataFlow',
  'parallelThresholdJoin',
  'pinnedArtifactInput',
  'planWideConcurrencyLimit',
  'planSchemaVersionValidation',
  'rootPipelineValidation',
  'repeatExecutionBoundValidation',
  'secretBoundaryResolution',
  'singleAttemptExecution',
  'singleTaskBindingValidation',
  'structuralNestingValidation',
  'subpipelineDataFlow',
  'subpipelineDepthValidation',
  'subpipelineFailureRouting',
  'subpipelineRecursionValidation',
  'taskFailureRouting',
  'terminalFailureEvent',
  'unhandledOutcomeFailure',
  'uniqueNodeKeyValidation',
  'unresolvedSecretFailure',
  'versionedScriptTaskExecution',
] as const satisfies readonly ScenarioCapability[];

const implementedCapabilitySet: ReadonlySet<ScenarioCapability> = new Set(implementedCapabilities);

export const missingScenarioCapabilities = (scenario: RunScenario): readonly ScenarioCapability[] =>
  scenario.requiredCapabilities.filter((capability) => !implementedCapabilitySet.has(capability));

export const isExecutableScenario = (scenario: RunScenario): boolean =>
  missingScenarioCapabilities(scenario).length === 0;

export const executablePipelineScenarios = plannedPipelineScenarios.filter(isExecutableScenario);

export const pendingPipelineScenarios = plannedPipelineScenarios.filter(
  (scenario) => !isExecutableScenario(scenario),
);
