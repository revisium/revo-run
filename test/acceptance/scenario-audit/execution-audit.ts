import type { ScenarioAuditEntry } from './scenario-audit-entry.js';

export const executionScenarioAudit = [
  {
    intentId: 'rr-001',
    requiredCapabilities: [
      'agentTaskExecution',
      'versionedScriptTaskExecution',
      'nodeOutputDataFlow',
    ],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-001' },
  },
  {
    intentId: 'rr-002',
    requiredCapabilities: ['agentTaskExecution', 'taskFailureRouting', 'singleAttemptExecution'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-002' },
  },
  {
    intentId: 'rr-003',
    requiredCapabilities: ['agentTaskExecution', 'taskTimeoutRouting', 'dbosSafeTimeAdvancement'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-003' },
  },
  {
    intentId: 'rr-004',
    requiredCapabilities: ['versionedScriptTaskExecution'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-004' },
  },
  {
    intentId: 'rr-005',
    requiredCapabilities: [
      'versionedScriptTaskExecution',
      'taskFailureRouting',
      'singleAttemptExecution',
    ],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-005' },
  },
  {
    intentId: 'rr-006',
    requiredCapabilities: [
      'versionedScriptTaskExecution',
      'taskTimeoutRouting',
      'dbosSafeTimeAdvancement',
    ],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-006' },
  },
  {
    intentId: 'rr-007',
    requiredCapabilities: [
      'agentTaskExecution',
      'retryableFailureRetry',
      'durableBackoff',
      'dbosSafeTimeAdvancement',
    ],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-007' },
  },
  {
    intentId: 'rr-008',
    requiredCapabilities: [
      'versionedScriptTaskExecution',
      'retryAttemptLimit',
      'durableBackoff',
      'dbosSafeTimeAdvancement',
    ],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-008' },
  },
  {
    intentId: 'rr-009',
    requiredCapabilities: ['retryErrorFiltering', 'singleAttemptExecution'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-009' },
  },
  {
    intentId: 'rr-010',
    requiredCapabilities: [
      'retryableFailureRetry',
      'durableBackoff',
      'managerRestartRecovery',
      'dbosSafeTimeAdvancement',
    ],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-010' },
  },
  {
    intentId: 'rr-011',
    requiredCapabilities: [
      'effectReconciliation',
      'managerRestartRecovery',
      'deduplicatedExecution',
    ],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['effectReconciliation', 'deduplicatedExecution'],
    },
  },
  {
    intentId: 'rr-012',
    requiredCapabilities: [
      'effectReconciliation',
      'unknownOutcomeResolution',
      'managerRestartRecovery',
      'deduplicatedExecution',
    ],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: [
        'effectReconciliation',
        'unknownOutcomeResolution',
        'deduplicatedExecution',
      ],
    },
  },
  {
    intentId: 'rr-013',
    requiredCapabilities: ['effectReconciliation', 'unknownOutcomeFailure'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['effectReconciliation', 'unknownOutcomeFailure'],
    },
  },
  {
    intentId: 'rr-014',
    requiredCapabilities: ['managerRestartRecovery', 'deduplicatedExecution'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['deduplicatedExecution'],
    },
  },
  {
    intentId: 'rr-015',
    requiredCapabilities: ['effectReconciliation', 'reconciliationAttemptLimit'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['effectReconciliation', 'reconciliationAttemptLimit'],
    },
  },
  {
    intentId: 'rr-016',
    requiredCapabilities: ['effectReconciliation', 'deduplicatedExecution'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['effectReconciliation', 'deduplicatedExecution'],
    },
  },
  {
    intentId: 'rr-017',
    requiredCapabilities: ['cooperativeRunCancellation'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['cooperativeRunCancellation'] },
  },
  {
    intentId: 'rr-018',
    requiredCapabilities: ['runCancellation', 'durableBackoff', 'dbosSafeTimeAdvancement'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['runCancellation'],
    },
  },
  {
    intentId: 'rr-019',
    requiredCapabilities: ['idempotentRunCancellation'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['idempotentRunCancellation'] },
  },
  {
    intentId: 'rr-020',
    requiredCapabilities: ['terminalStateImmutability', 'commandRejection'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['terminalStateImmutability', 'commandRejection'],
    },
  },
  {
    intentId: 'rr-021',
    requiredCapabilities: ['unhandledOutcomeFailure'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-021' },
  },
  {
    intentId: 'rr-022',
    requiredCapabilities: ['ownPropertyOutcomeRouting'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-022' },
  },
] as const satisfies readonly ScenarioAuditEntry[];
