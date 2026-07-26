import type { LifecycleEventCursor } from './lifecycle-event-cursor.js';

export interface LifecycleReplayed<Value> {
  readonly kind: 'replayed';
  readonly value: Value;
  readonly committedAt: number;
  readonly cursor: LifecycleEventCursor;
}
