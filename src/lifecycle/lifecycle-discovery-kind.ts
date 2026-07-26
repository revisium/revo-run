export type LifecycleDiscoveryKind =
  | 'handoff_attempt'
  | 'expired_attempt'
  | 'renewable_attempt'
  | 'claimable_node'
  | 'cancellation_run'
  | 'progressable_run';
