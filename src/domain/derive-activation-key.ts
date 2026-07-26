import { digestCanonicalJson } from '../policy/index.js';
import type { ActivationKey, BranchKey, ForkScopeKey } from '../spec/index.js';
import { domainValidation } from './domain-validation.js';

export const deriveActivationKey = (coordinates: {
  readonly nodeKey: string;
  readonly forkScopeKey: ForkScopeKey;
  readonly branchKey: BranchKey | null;
  readonly iteration: number;
}): ActivationKey =>
  digestCanonicalJson([
    'revo-run',
    'activation-key',
    'v1',
    domainValidation.boundedString(coordinates.nodeKey),
    domainValidation.canonicalDigest(coordinates.forkScopeKey),
    coordinates.branchKey === null ? null : domainValidation.boundedString(coordinates.branchKey),
    domainValidation.nonnegativeInteger(coordinates.iteration),
  ]);
