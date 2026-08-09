import type {
  RequiredScenarioCapabilities,
  ScenarioCapability,
  ScenarioIntentId,
} from '../../dsl/run-scenario.js';

export interface ScenarioAuditEntry {
  readonly intentId: ScenarioIntentId;
  readonly requiredCapabilities: RequiredScenarioCapabilities;
  readonly evidence:
    | {
        readonly kind: 'executableScenario';
        readonly proofIntentId: ScenarioIntentId;
      }
    | {
        readonly kind: 'pendingCapabilities';
        readonly missingCapabilities: readonly [ScenarioCapability, ...ScenarioCapability[]];
      };
}

export const executableScenarioProofTest = 'test/acceptance/pipeline-execution.test.ts';
