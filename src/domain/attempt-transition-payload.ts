import type { RunFaultCode } from '../errors/index.js';

type FailurePayload<Cause extends string, From extends string> = {
  readonly cause: Cause;
  readonly from: From;
  readonly to: 'failed';
  readonly faultCode: RunFaultCode;
  readonly retryScheduled: boolean;
};

export type AttemptTransitionPayload =
  | {
      readonly cause: 'start';
      readonly from: 'claimed';
      readonly to: 'start_committed';
    }
  | FailurePayload<'pre_start_resolution_failure', 'claimed'>
  | {
      readonly cause: 'pre_start_cancellation';
      readonly from: 'claimed';
      readonly to: 'cancelled';
    }
  | {
      readonly cause: 'direct_success';
      readonly from: 'start_committed';
      readonly to: 'succeeded';
    }
  | FailurePayload<'direct_failure', 'start_committed'>
  | {
      readonly cause: 'direct_cancellation';
      readonly from: 'start_committed';
      readonly to: 'cancelled';
    }
  | {
      readonly cause: 'direct_unknown';
      readonly from: 'start_committed';
      readonly to: 'unknown';
      readonly faultCode: 'UNKNOWN_OUTCOME';
    }
  | {
      readonly cause: 'reconciliation_started';
      readonly from: 'unknown';
      readonly to: 'reconciling';
    }
  | {
      readonly cause: 'late_success';
      readonly from: 'unknown';
      readonly to: 'succeeded';
    }
  | FailurePayload<'late_failure', 'unknown'>
  | {
      readonly cause: 'late_cancellation';
      readonly from: 'unknown';
      readonly to: 'cancelled';
    }
  | {
      readonly cause: 'reconciled_running';
      readonly from: 'reconciling';
      readonly to: 'start_committed';
    }
  | {
      readonly cause: 'reconciled_unknown';
      readonly from: 'reconciling';
      readonly to: 'unknown';
    }
  | {
      readonly cause: 'reconciled_success';
      readonly from: 'reconciling';
      readonly to: 'succeeded';
    }
  | FailurePayload<'reconciled_failure', 'reconciling'>
  | {
      readonly cause: 'reconciled_cancellation';
      readonly from: 'reconciling';
      readonly to: 'cancelled';
    };
