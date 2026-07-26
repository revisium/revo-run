import type { ExecutorBindingMismatchReason } from './executor-binding-mismatch-reason.js';
import type { VerifiedExecutorBinding } from './verified-executor-binding.js';

export type ExecutorBindingVerificationResult =
  | { readonly kind: 'verified'; readonly evidence: VerifiedExecutorBinding }
  | { readonly kind: 'mismatch'; readonly reason: ExecutorBindingMismatchReason };
