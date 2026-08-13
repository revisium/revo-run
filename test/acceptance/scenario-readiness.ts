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
  'cooperativeRunCancellation',
  'commandRejection',
  'defaultOutcomeBranch',
  'dbosSafeTimeAdvancement',
  'duplicateTaskBindingValidation',
  'durableBackoff',
  'effectReconciliation',
  'entityReferenceInput',
  'inertReferenceShapedJson',
  'identifierValidation',
  'idempotentRunCancellation',
  'missingEntityVersionFailure',
  'missingJsonPointerFailure',
  'missingOutputKeyFailure',
  'missingSubpipelineValidation',
  'nestedParallelExecution',
  'nodeOutputDataFlow',
  'noBlindEffectRepeat',
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
  'parallelCancellation',
  'parallelThresholdJoin',
  'pinnedArtifactInput',
  'planWideConcurrencyLimit',
  'planSchemaVersionValidation',
  'runDetailsProjection',
  'runCancellation',
  'runEventSubscription',
  'rootPipelineValidation',
  'repeatExecutionBoundValidation',
  'reconciliationAttemptLimit',
  'retryAttemptLimit',
  'retryErrorFiltering',
  'retryableFailureRetry',
  'secretBoundaryResolution',
  'singleAttemptExecution',
  'singleTaskBindingValidation',
  'structuralNestingValidation',
  'subpipelineDataFlow',
  'subpipelineDepthValidation',
  'subpipelineFailureRouting',
  'subpipelineRecursionValidation',
  'subscriptionCursorValidation',
  'subscriptionRecovery',
  'taskFailureRouting',
  'taskTimeoutRouting',
  'terminalFailureEvent',
  'terminalStateImmutability',
  'unhandledOutcomeFailure',
  'uniqueNodeKeyValidation',
  'unresolvedSecretFailure',
  'unknownOutcomeFailure',
  'unknownOutcomeResolution',
  'versionedScriptTaskExecution',
  'managerRestartRecovery',
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
