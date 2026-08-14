import type { ScenarioAuditEntry } from './scenario-audit-entry.js';

export const enterpriseLifecycleScenarioAudit = [
  {
    intentId: 'rr-075',
    requiredCapabilities: [
      'durableDelayRecovery',
      'managerRestartRecovery',
      'dbosSafeTimeAdvancement',
    ],
    evidence: {
      kind: 'executableScenario',
      proofIntentId: 'rr-075',
    },
  },
  {
    intentId: 'rr-076',
    requiredCapabilities: ['durableDelayCancellation', 'dbosSafeTimeAdvancement'],
    evidence: {
      kind: 'executableScenario',
      proofIntentId: 'rr-076',
    },
  },
  {
    intentId: 'rr-077',
    requiredCapabilities: ['parallelCancellation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-077' },
  },
  {
    intentId: 'rr-078',
    requiredCapabilities: ['parallelRecovery', 'managerRestartRecovery', 'noBlindEffectRepeat'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-078' },
  },
  {
    intentId: 'rr-079',
    requiredCapabilities: ['planWideConcurrencyLimit'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-079' },
  },
  {
    intentId: 'rr-080',
    requiredCapabilities: ['runEventSubscription'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-080' },
  },
  {
    intentId: 'rr-081',
    requiredCapabilities: ['terminalFailureEvent'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-081' },
  },
  {
    intentId: 'rr-082',
    requiredCapabilities: ['subscriptionCursorValidation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-082' },
  },
  {
    intentId: 'rr-083',
    requiredCapabilities: ['runDetailsProjection'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-083' },
  },
  {
    intentId: 'rr-084',
    requiredCapabilities: ['subscriptionRecovery', 'managerRestartRecovery'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-084' },
  },
] as const satisfies readonly ScenarioAuditEntry[];
