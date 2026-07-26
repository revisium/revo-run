import type { RunStoreInvalidInput } from './run-store-invalid-input.js';

export type RunStoreLookupResult<Value> =
  | { readonly kind: 'found'; readonly value: Value }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_input'; readonly fault: RunStoreInvalidInput };
