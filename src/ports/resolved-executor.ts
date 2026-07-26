import type { ExecutorContractPin } from '../spec/index.js';
import type { ExecutorCancelRequest } from './executor-cancel-request.js';
import type { ExecutorCancelResult } from './executor-cancel-result.js';
import type { ExecutorExecuteRequest } from './executor-execute-request.js';
import type { ExecutorExecuteResult } from './executor-execute-result.js';
import type { ExecutorReconcileRequest } from './executor-reconcile-request.js';
import type { ExecutorReconcileResult } from './executor-reconcile-result.js';

export interface ResolvedExecutor {
  readonly contractPin: ExecutorContractPin;
  execute(request: ExecutorExecuteRequest): Promise<ExecutorExecuteResult>;
  reconcile?(request: ExecutorReconcileRequest): Promise<ExecutorReconcileResult>;
  cancel?(request: ExecutorCancelRequest): Promise<ExecutorCancelResult>;
}
