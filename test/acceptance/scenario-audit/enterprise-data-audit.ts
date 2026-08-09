import type { ScenarioAuditEntry } from './scenario-audit-entry.js';

export const enterpriseDataScenarioAudit = [
  {
    intentId: 'rr-058',
    requiredCapabilities: ['entityReferenceInput'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-058' },
  },
  {
    intentId: 'rr-059',
    requiredCapabilities: ['artifactReferenceDataFlow'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-059' },
  },
  {
    intentId: 'rr-060',
    requiredCapabilities: ['secretBoundaryResolution'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-060' },
  },
  {
    intentId: 'rr-061',
    requiredCapabilities: ['inertReferenceShapedJson'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-061' },
  },
  {
    intentId: 'rr-062',
    requiredCapabilities: ['unresolvedSecretFailure'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-062' },
  },
  {
    intentId: 'rr-063',
    requiredCapabilities: ['missingEntityVersionFailure'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-063' },
  },
  {
    intentId: 'rr-064',
    requiredCapabilities: ['artifactOutput'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-064' },
  },
  {
    intentId: 'rr-065',
    requiredCapabilities: ['pinnedArtifactInput'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-065' },
  },
  {
    intentId: 'rr-066',
    requiredCapabilities: ['missingOutputKeyFailure'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-066' },
  },
  {
    intentId: 'rr-067',
    requiredCapabilities: ['missingJsonPointerFailure'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-067' },
  },
  {
    intentId: 'rr-068',
    requiredCapabilities: ['boundedMapExecution'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['boundedMapExecution'] },
  },
  {
    intentId: 'rr-069',
    requiredCapabilities: ['emptyMapCompletion'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['emptyMapCompletion'] },
  },
  {
    intentId: 'rr-070',
    requiredCapabilities: ['mapPathEncoding'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['mapPathEncoding'] },
  },
  {
    intentId: 'rr-071',
    requiredCapabilities: ['mapItemBound'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['mapItemBound'] },
  },
  {
    intentId: 'rr-072',
    requiredCapabilities: ['mapFailFast'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['mapFailFast'] },
  },
  {
    intentId: 'rr-073',
    requiredCapabilities: ['mapConcurrencyLimit'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['mapConcurrencyLimit'] },
  },
  {
    intentId: 'rr-074',
    requiredCapabilities: ['mapFailureAggregation'],
    evidence: { kind: 'pendingCapabilities', missingCapabilities: ['mapFailureAggregation'] },
  },
] as const satisfies readonly ScenarioAuditEntry[];
