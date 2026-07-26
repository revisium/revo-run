import { digestCanonicalJson } from '../policy/index.js';
import type { ForkScopeKey, RunActivationId } from '../spec/index.js';
import { domainValidation } from './domain-validation.js';

export const deriveChildForkScopeKey = (
  parentForkScopeKey: ForkScopeKey,
  forkActivationId: RunActivationId,
): ForkScopeKey =>
  digestCanonicalJson([
    'revo-run',
    'fork-scope',
    'v1',
    domainValidation.canonicalDigest(parentForkScopeKey),
    domainValidation.boundedString(forkActivationId),
  ]);
