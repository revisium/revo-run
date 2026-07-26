import type { RunFault } from '../errors/index.js';
import type { Attempt } from './attempt.js';
import type { DomainAuthority } from './domain-authority.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';
import type { Run } from './run.js';

type AttemptOperationBase<Kind extends string> = {
  readonly kind: Kind;
  readonly run: Run;
  readonly node: RunNodeInstance;
  readonly attempt: Attempt;
  readonly authority: DomainAuthority;
};

type FailureOperation<Kind extends string> = AttemptOperationBase<Kind> & {
  readonly fault: RunFault;
  readonly retryAvailableAt: number | null;
};

type SuccessOperation<Kind extends string> = AttemptOperationBase<Kind> & {
  readonly outputs: readonly RunOutput[];
};

export type DomainOperation =
  | {
      readonly kind: 'activate_nodes';
      readonly run: Run;
      readonly nodes: readonly RunNodeInstance[];
      readonly transactionNow: number;
    }
  | {
      readonly kind: 'claim';
      readonly run: Run;
      readonly node: RunNodeInstance;
      readonly attempt: Attempt;
      readonly expectedRunRevision: number;
      readonly expectedNodeRevision: number;
      readonly transactionNow: number;
    }
  | AttemptOperationBase<'start'>
  | (AttemptOperationBase<'renew_lease'> & {
      readonly nextLastHeartbeatAt: number;
      readonly nextLeaseExpiresAt: number;
    })
  | FailureOperation<'pre_start_failure'>
  | AttemptOperationBase<'pre_start_cancellation'>
  | SuccessOperation<'direct_success'>
  | FailureOperation<'direct_failure'>
  | AttemptOperationBase<'direct_cancellation'>
  | (AttemptOperationBase<'direct_unknown'> & { readonly fault: RunFault })
  | AttemptOperationBase<'begin_reconciliation'>
  | SuccessOperation<'late_success'>
  | FailureOperation<'late_failure'>
  | AttemptOperationBase<'late_cancellation'>
  | AttemptOperationBase<'reconciled_running'>
  | AttemptOperationBase<'reconciled_unknown'>
  | SuccessOperation<'reconciled_success'>
  | FailureOperation<'reconciled_failure'>
  | AttemptOperationBase<'reconciled_cancellation'>
  | {
      readonly kind: 'request_cancellation';
      readonly run: Run;
      readonly nodes: readonly RunNodeInstance[];
      readonly attempts: readonly Attempt[];
      readonly transactionNow: number;
    }
  | {
      readonly kind: 'gate_answer';
      readonly run: Run;
      readonly node: RunNodeInstance;
      readonly output: RunOutput;
      readonly expectedRunRevision: number;
      readonly expectedNodeRevision: number;
      readonly transactionNow: number;
    }
  | {
      readonly kind: 'join_ready';
      readonly run: Run;
      readonly node: RunNodeInstance;
      readonly expectedRunRevision: number;
      readonly expectedNodeRevision: number;
      readonly transactionNow: number;
    }
  | {
      readonly kind: 'join_succeeded';
      readonly run: Run;
      readonly node: RunNodeInstance;
      readonly expectedRunRevision: number;
      readonly expectedNodeRevision: number;
      readonly transactionNow: number;
    };
