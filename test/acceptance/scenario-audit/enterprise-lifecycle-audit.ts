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
      kind: 'pendingCapabilities',
      missingCapabilities: [
        'durableDelayRecovery',
        'managerRestartRecovery',
        'dbosSafeTimeAdvancement',
      ],
    },
  },
  {
    intentId: 'rr-076',
    requiredCapabilities: ['durableDelayCancellation', 'dbosSafeTimeAdvancement'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['durableDelayCancellation', 'dbosSafeTimeAdvancement'],
    },
  },
  {
    intentId: 'rr-077',
    requiredCapabilities: ['parallelCancellation'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['parallelCancellation'] },
  },
  {
    intentId: 'rr-078',
    requiredCapabilities: ['parallelRecovery', 'managerRestartRecovery', 'deduplicatedExecution'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['parallelRecovery', 'managerRestartRecovery', 'deduplicatedExecution'],
    },
  },
  {
    intentId: 'rr-079',
    requiredCapabilities: ['planWideConcurrencyLimit'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-079' },
  },
  {
    intentId: 'rr-080',
    requiredCapabilities: ['runEventSubscription'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['runEventSubscription'] },
  },
  {
    intentId: 'rr-081',
    requiredCapabilities: ['terminalFailureEvent'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-081' },
  },
  {
    intentId: 'rr-082',
    requiredCapabilities: ['subscriptionCursorValidation'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['subscriptionCursorValidation'],
    },
  },
  {
    intentId: 'rr-083',
    requiredCapabilities: ['runDetailsProjection'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['runDetailsProjection'] },
  },
  {
    intentId: 'rr-084',
    requiredCapabilities: ['subscriptionRecovery', 'managerRestartRecovery'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['subscriptionRecovery', 'managerRestartRecovery'],
    },
  },
] as const satisfies readonly ScenarioAuditEntry[];
