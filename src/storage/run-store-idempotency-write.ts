import type { JsonValue } from '../spec/index.js';
import type { RunStoreIdempotencyIdentity } from './run-store-idempotency-identity.js';

export interface RunStoreIdempotencyWrite {
  readonly identity: RunStoreIdempotencyIdentity;
  readonly request: JsonValue;
  readonly result: JsonValue;
}
