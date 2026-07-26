import type { RunStoreInvalidInput } from './run-store-invalid-input.js';

export type RunStorePageReadResult<Page> =
  | { readonly kind: 'page'; readonly page: Page }
  | { readonly kind: 'invalid_input'; readonly fault: RunStoreInvalidInput };
