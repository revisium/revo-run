import type { DomainTransition } from '../domain/index.js';
import type { RunStoreIncumbentAuthority } from './run-store-incumbent-authority.js';
import type { RunStoreIncumbentTransitionExpected } from './run-store-incumbent-transition-expected.js';

export interface RunStoreIncumbentTransitionBase {
  readonly kind: 'apply_incumbent_transition';
  readonly transition: DomainTransition;
  readonly expected: RunStoreIncumbentTransitionExpected;
  readonly authority: RunStoreIncumbentAuthority;
}
