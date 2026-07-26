export type RunStoreDiscoveryKind =
  | 'handoff_attempt'
  | 'expired_attempt'
  | 'renewable_attempt'
  | 'claimable_node'
  | 'cancellation_run'
  | 'progressable_run';
