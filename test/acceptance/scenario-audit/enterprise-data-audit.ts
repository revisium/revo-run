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
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-068' },
  },
  {
    intentId: 'rr-069',
    requiredCapabilities: ['emptyMapCompletion'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-069' },
  },
  {
    intentId: 'rr-070',
    requiredCapabilities: ['mapPathEncoding'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-070' },
  },
  {
    intentId: 'rr-071',
    requiredCapabilities: ['mapItemBound'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-071' },
  },
  {
    intentId: 'rr-072',
    requiredCapabilities: ['mapFailFast'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-072' },
  },
  {
    intentId: 'rr-073',
    requiredCapabilities: ['mapConcurrencyLimit'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-073' },
  },
  {
    intentId: 'rr-074',
    requiredCapabilities: ['mapFailureAggregation'],
    evidence: { kind: 'executableScenario', proofIntentId: 'rr-074' },
  },
] as const satisfies readonly ScenarioAuditEntry[];
