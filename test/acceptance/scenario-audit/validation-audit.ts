import type { ScenarioAuditEntry } from './scenario-audit-entry.js';

export const validationScenarioAudit = [
  {
    intentId: 'rr-085',
    requiredCapabilities: ['planSchemaVersionValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-085' },
  },
  {
    intentId: 'rr-086',
    requiredCapabilities: ['rootPipelineValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-086' },
  },
  {
    intentId: 'rr-087',
    requiredCapabilities: ['singleTaskBindingValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-087' },
  },
  {
    intentId: 'rr-088',
    requiredCapabilities: ['duplicateTaskBindingValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-088' },
  },
  {
    intentId: 'rr-089',
    requiredCapabilities: ['repeatExecutionBoundValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-089' },
  },
  {
    intentId: 'rr-090',
    requiredCapabilities: ['branchDefaultValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-090' },
  },
  {
    intentId: 'rr-091',
    requiredCapabilities: ['bindingTargetValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-091' },
  },
  {
    intentId: 'rr-092',
    requiredCapabilities: ['bindingTargetValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-092' },
  },
  {
    intentId: 'rr-093',
    requiredCapabilities: ['uniqueNodeKeyValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-093' },
  },
  {
    intentId: 'rr-094',
    requiredCapabilities: ['uniqueNodeKeyValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-094' },
  },
  {
    intentId: 'rr-095',
    requiredCapabilities: ['identifierValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-095' },
  },
  {
    intentId: 'rr-096',
    requiredCapabilities: ['identifierValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-096' },
  },
  {
    intentId: 'rr-097',
    requiredCapabilities: ['uniqueMapItemKeyValidation'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['uniqueMapItemKeyValidation'] },
  },
  {
    intentId: 'rr-098',
    requiredCapabilities: ['consensusThresholdValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-098' },
  },
  {
    intentId: 'rr-099',
    requiredCapabilities: ['composedExecutionBoundValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-099' },
  },
  {
    intentId: 'rr-100',
    requiredCapabilities: ['structuralNestingValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-100' },
  },
  {
    intentId: 'rr-101',
    requiredCapabilities: ['subpipelineDepthValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-101' },
  },
  {
    intentId: 'rr-102',
    requiredCapabilities: ['subpipelineRecursionValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-102' },
  },
  {
    intentId: 'rr-103',
    requiredCapabilities: ['subpipelineRecursionValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-103' },
  },
] as const satisfies readonly ScenarioAuditEntry[];
