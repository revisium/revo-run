import type { ManagerLifecycleIdempotencyPurpose } from './manager-lifecycle-idempotency-purpose.js';

export interface ManagerIdSource {
  /** Returns a fresh durable Run identifier. */
  nextRunId(): string;
  /** Returns a fresh logical pipeline occurrence identifier. */
  nextProgressionOccurrenceKey(): string;
  /** Returns a fresh seed for deterministic progression entity allocation. */
  nextProgressionAllocationSeed(): string;
  /** Returns a fresh bounded identifier for each manager start cycle. */
  nextManagerIncarnationId(): string;
  /** Returns a fresh bounded Attempt identifier. */
  nextAttemptId(): string;
  /** Returns a fresh bounded durable handoff identifier. */
  nextHandoffId(): string;
  /** Returns a fresh bounded immutable output identifier. */
  nextOutputId(): string;
  /** Returns a fresh bounded key for one exact durable lifecycle operation. */
  nextLifecycleIdempotencyKey(purpose: ManagerLifecycleIdempotencyPurpose): string;
}
