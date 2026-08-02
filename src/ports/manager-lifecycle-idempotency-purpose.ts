export type ManagerLifecycleIdempotencyPurpose =
  | 'acquire'
  | 'claim'
  | 'prepare_reconciliation'
  | 'process_execute_observation'
  | 'process_reconcile_observation'
  | 'progress_task_outcome'
  | 'verify_and_start'
  | 'write_handoff';
