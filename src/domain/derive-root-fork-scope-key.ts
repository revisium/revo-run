import { digestCanonicalJson } from '../policy/index.js';
import type { ForkScopeKey } from '../spec/index.js';
import { domainValidation } from './domain-validation.js';

export const deriveRootForkScopeKey = (runId: string): ForkScopeKey =>
  digestCanonicalJson([
    'revo-run',
    'fork-scope',
    'v1',
    'root',
    domainValidation.boundedString(runId),
  ]);
