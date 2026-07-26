export type AttemptStatus =
  | 'claimed'
  | 'start_committed'
  | 'unknown'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
