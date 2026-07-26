import type { DomainOperation } from './domain-operation.js';
import { domainReducers } from './domain-reducers.js';
import type { DomainTransition } from './domain-transition.js';
import { reconstructDomainOperation } from './reconstruct-domain-operation.js';

export const applyDomainOperation = (operation: DomainOperation): DomainTransition => {
  const validated = reconstructDomainOperation(operation);
  switch (validated.kind) {
    case 'activate_nodes':
      return domainReducers.activateNodes(validated);
    case 'claim':
      return domainReducers.claim(validated);
    case 'start':
      return domainReducers.start(validated);
    case 'renew_lease':
      return domainReducers.renewLease(validated);
    case 'pre_start_failure':
      return domainReducers.failure(
        validated,
        'executing',
        'claimed',
        'pre_start_resolution_failure',
      );
    case 'pre_start_cancellation':
      return domainReducers.cancellation(
        validated,
        'executing',
        'claimed',
        'pre_start_cancellation',
      );
    case 'direct_success':
      return domainReducers.success(validated, 'executing', 'start_committed', 'direct_success');
    case 'direct_failure':
      return domainReducers.failure(validated, 'executing', 'start_committed', 'direct_failure');
    case 'direct_cancellation':
      return domainReducers.cancellation(
        validated,
        'executing',
        'start_committed',
        'direct_cancellation',
      );
    case 'direct_unknown':
      return domainReducers.directUnknown(validated);
    case 'begin_reconciliation':
      return domainReducers.beginReconciliation(validated);
    case 'late_success':
      return domainReducers.success(validated, 'unknown', 'unknown', 'late_success');
    case 'late_failure':
      return domainReducers.failure(validated, 'unknown', 'unknown', 'late_failure');
    case 'late_cancellation':
      return domainReducers.cancellation(validated, 'unknown', 'unknown', 'late_cancellation');
    case 'reconciled_running':
      return domainReducers.reconciledRunning(validated);
    case 'reconciled_unknown':
      return domainReducers.reconciledUnknown(validated);
    case 'reconciled_success':
      return domainReducers.success(validated, 'unknown', 'reconciling', 'reconciled_success');
    case 'reconciled_failure':
      return domainReducers.failure(validated, 'unknown', 'reconciling', 'reconciled_failure');
    case 'reconciled_cancellation':
      return domainReducers.cancellation(
        validated,
        'unknown',
        'reconciling',
        'reconciled_cancellation',
      );
    case 'request_cancellation':
      return domainReducers.requestCancellation(validated);
    case 'gate_answer':
      return domainReducers.gateAnswer(validated);
    case 'join_ready':
    case 'join_succeeded':
      return domainReducers.joinTransition(validated);
  }
  throw new TypeError('Domain operation kind is invalid.');
};
