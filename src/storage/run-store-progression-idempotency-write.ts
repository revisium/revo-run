import type { RunProgressionAppliedReceipt } from '../domain/index.js';
import type { JsonValue } from '../spec/index.js';
import type { RunStoreIdempotencyIdentity } from './run-store-idempotency-identity.js';

export interface RunStoreProgressionIdempotencyWrite {
  readonly identity: RunStoreIdempotencyIdentity;
  readonly request: JsonValue;
  readonly result: RunProgressionAppliedReceipt;
}
