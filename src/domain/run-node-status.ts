export type RunNodeStatus =
  | 'ready'
  | 'executing'
  | 'retry_waiting'
  | 'unknown'
  | 'gate_waiting'
  | 'join_waiting'
  | 'selector_waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'retiring'
  | 'retired';
