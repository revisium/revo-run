export type ExecutorBindingMismatchReason =
  | 'binding_configuration_digest_mismatch'
  | 'attempt_adapter_id_mismatch'
  | 'attempt_revision_mismatch'
  | 'attempt_contract_digest_mismatch'
  | 'attempt_configuration_digest_mismatch'
  | 'resolved_adapter_id_mismatch'
  | 'resolved_revision_mismatch'
  | 'resolved_contract_digest_mismatch';
