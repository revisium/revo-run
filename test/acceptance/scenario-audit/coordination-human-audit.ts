import type { ScenarioAuditEntry } from './scenario-audit-entry.js';

export const coordinationHumanScenarioAudit = [
  {
    intentId: 'rr-043',
    requiredCapabilities: ['humanGateRecovery', 'managerRestartRecovery'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['humanGateRecovery'],
    },
  },
  {
    intentId: 'rr-044',
    requiredCapabilities: ['humanGateCommandIdempotency', 'commandRejection'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['humanGateCommandIdempotency'],
    },
  },
  {
    intentId: 'rr-045',
    requiredCapabilities: ['separationOfDuties', 'commandRejection'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['separationOfDuties'],
    },
  },
  {
    intentId: 'rr-046',
    requiredCapabilities: ['humanGateAuthorization', 'commandRejection'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['humanGateAuthorization'],
    },
  },
  {
    intentId: 'rr-047',
    requiredCapabilities: ['humanGateConflictPolicy'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['humanGateConflictPolicy'] },
  },
  {
    intentId: 'rr-048',
    requiredCapabilities: ['humanGateAnswerValidation', 'commandRejection'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['humanGateAnswerValidation'],
    },
  },
  {
    intentId: 'rr-049',
    requiredCapabilities: ['humanGateDeadlineRouting', 'dbosSafeTimeAdvancement'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['humanGateDeadlineRouting'],
    },
  },
  {
    intentId: 'rr-050',
    requiredCapabilities: ['humanGateCancellation'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['humanGateCancellation'] },
  },
  {
    intentId: 'rr-051',
    requiredCapabilities: ['subpipelineDataFlow'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-051' },
  },
  {
    intentId: 'rr-052',
    requiredCapabilities: ['subpipelineFailureRouting'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-052' },
  },
  {
    intentId: 'rr-053',
    requiredCapabilities: ['missingSubpipelineValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-053' },
  },
  {
    intentId: 'rr-054',
    requiredCapabilities: ['repeatIterationDataFlow'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-054' },
  },
  {
    intentId: 'rr-055',
    requiredCapabilities: ['nestedRepeat'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-055' },
  },
  {
    intentId: 'rr-056',
    requiredCapabilities: ['repeatExhaustionRouting'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-056' },
  },
  {
    intentId: 'rr-057',
    requiredCapabilities: ['boundedRepeatValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-057' },
  },
] as const satisfies readonly ScenarioAuditEntry[];
