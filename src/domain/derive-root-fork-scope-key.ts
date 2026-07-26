import { digestCanonicalJson } from '../policy/index.js';
import type { ForkScopeKey, RunId } from '../spec/index.js';
import { domainValidation } from './domain-validation.js';

export const deriveRootForkScopeKey = (runId: RunId): ForkScopeKey =>
  digestCanonicalJson([
    'revo-run',
    'fork-scope',
    'v1',
    'root',
    domainValidation.boundedString(runId),
  ]);
