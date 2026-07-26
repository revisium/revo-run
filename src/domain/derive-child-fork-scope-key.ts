import { digestCanonicalJson } from '../policy/index.js';
import type { ForkScopeKey } from '../spec/index.js';
import { domainValidation } from './domain-validation.js';

export const deriveChildForkScopeKey = (
  parentForkScopeKey: ForkScopeKey,
  forkActivationId: string,
): ForkScopeKey =>
  digestCanonicalJson([
    'revo-run',
    'fork-scope',
    'v1',
    domainValidation.canonicalDigest(parentForkScopeKey),
    domainValidation.boundedString(forkActivationId),
  ]);
