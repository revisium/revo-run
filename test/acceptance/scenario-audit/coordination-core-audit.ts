import type { ScenarioAuditEntry } from './scenario-audit-entry.js';

export const coordinationCoreScenarioAudit = [
  {
    intentId: 'rr-023',
    requiredCapabilities: ['outcomeBranchSelection'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-023' },
  },
  {
    intentId: 'rr-024',
    requiredCapabilities: ['defaultOutcomeBranch'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-024' },
  },
  {
    intentId: 'rr-025',
    requiredCapabilities: ['parallelAllJoin'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-025' },
  },
  {
    intentId: 'rr-026',
    requiredCapabilities: ['parallelBranchComposition'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-026' },
  },
  {
    intentId: 'rr-027',
    requiredCapabilities: ['parallelAllJoinFailure', 'parallelBranchDrain'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-027' },
  },
  {
    intentId: 'rr-028',
    requiredCapabilities: ['parallelAnyJoin', 'parallelBranchDrain'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-028' },
  },
  {
    intentId: 'rr-029',
    requiredCapabilities: ['parallelAnyJoinFailure'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-029' },
  },
  {
    intentId: 'rr-030',
    requiredCapabilities: ['parallelThresholdJoin', 'parallelBranchDrain'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-030' },
  },
  {
    intentId: 'rr-031',
    requiredCapabilities: ['parallelInputFailure'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-031' },
  },
  {
    intentId: 'rr-032',
    requiredCapabilities: ['parallelOutputDataFlow'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-032' },
  },
  {
    intentId: 'rr-033',
    requiredCapabilities: ['planWideConcurrencyLimit', 'nestedParallelExecution'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-033' },
  },
  {
    intentId: 'rr-034',
    requiredCapabilities: ['parallelThresholdJoin', 'parallelBranchCancellation'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['parallelBranchCancellation'] },
  },
  {
    intentId: 'rr-035',
    requiredCapabilities: ['parallelThresholdUnreachable'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['parallelThresholdUnreachable'],
    },
  },
  {
    intentId: 'rr-036',
    requiredCapabilities: ['consensusExecution', 'normalizedConsensusVote', 'unanimousConsensus'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['consensusExecution', 'normalizedConsensusVote', 'unanimousConsensus'],
    },
  },
  {
    intentId: 'rr-037',
    requiredCapabilities: [
      'consensusExecution',
      'normalizedConsensusVote',
      'earlyConsensusRejection',
    ],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: [
        'consensusExecution',
        'normalizedConsensusVote',
        'earlyConsensusRejection',
      ],
    },
  },
  {
    intentId: 'rr-038',
    requiredCapabilities: ['consensusExecution', 'normalizedConsensusVote', 'consensusQuorum'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['consensusExecution', 'normalizedConsensusVote', 'consensusQuorum'],
    },
  },
  {
    intentId: 'rr-039',
    requiredCapabilities: [
      'consensusExecution',
      'normalizedConsensusVote',
      'independentConsensusThresholds',
    ],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: [
        'consensusExecution',
        'normalizedConsensusVote',
        'independentConsensusThresholds',
      ],
    },
  },
  {
    intentId: 'rr-040',
    requiredCapabilities: [
      'consensusExecution',
      'normalizedConsensusVote',
      'consensusVoteValidation',
    ],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: [
        'consensusExecution',
        'normalizedConsensusVote',
        'consensusVoteValidation',
      ],
    },
  },
  {
    intentId: 'rr-041',
    requiredCapabilities: ['consensusExecution', 'consensusParticipantFailureWithoutVote'],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: ['consensusExecution', 'consensusParticipantFailureWithoutVote'],
    },
  },
  {
    intentId: 'rr-042',
    requiredCapabilities: [
      'consensusExecution',
      'consensusTimeoutRouting',
      'dbosSafeTimeAdvancement',
    ],
    evidence: {
      kind: 'pendingCapabilities',
      missingCapabilities: [
        'consensusExecution',
        'consensusTimeoutRouting',
        'dbosSafeTimeAdvancement',
      ],
    },
  },
] as const satisfies readonly ScenarioAuditEntry[];
