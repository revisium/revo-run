import type { LifecycleEventCursor } from './lifecycle-event-cursor.js';

export interface LifecycleCommitted<Value> {
  readonly kind: 'committed';
  readonly value: Value;
  readonly transactionNow: number;
  readonly cursor: LifecycleEventCursor;
}
