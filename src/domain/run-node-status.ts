export type RunNodeStatus =
  | 'ready'
  | 'executing'
  | 'retry_waiting'
  | 'unknown'
  | 'gate_waiting'
  | 'join_waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
