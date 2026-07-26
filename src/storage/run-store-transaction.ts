import type { Attempt, Run, RunNodeInstance } from '../domain/index.js';
import type { AttemptHandoffKey } from './attempt-handoff-key.js';
import type { AttemptHandoffState } from './attempt-handoff-state.js';
import type { RunStoreAttemptPage } from './run-store-attempt-page.js';
import type { RunStoreAttemptQuery } from './run-store-attempt-query.js';
import type { RunStoreCommitCommand } from './run-store-commit-command.js';
import type { RunStoreCommitResult } from './run-store-commit-result.js';
import type { RunStoreIdempotencyIdentity } from './run-store-idempotency-identity.js';
import type { RunStoreIdempotencyRecord } from './run-store-idempotency-record.js';
import type { RunStoreLookupResult } from './run-store-lookup-result.js';
import type { RunStoreNodePage } from './run-store-node-page.js';
import type { RunStoreNodeQuery } from './run-store-node-query.js';
import type { RunStoreOutputPage } from './run-store-output-page.js';
import type { RunStoreOutputQuery } from './run-store-output-query.js';
import type { RunStorePageReadResult } from './run-store-page-read-result.js';

export interface RunStoreTransaction {
  readonly transactionNow: number;
  getRun(runId: string): Promise<RunStoreLookupResult<Run>>;
  getNode(nodeInstanceId: string): Promise<RunStoreLookupResult<RunNodeInstance>>;
  getNodeByActivation(
    runId: string,
    activationId: string,
  ): Promise<RunStoreLookupResult<RunNodeInstance>>;
  getAttempt(attemptId: string): Promise<RunStoreLookupResult<Attempt>>;
  listNodes(query: RunStoreNodeQuery): Promise<RunStorePageReadResult<RunStoreNodePage>>;
  listAttempts(query: RunStoreAttemptQuery): Promise<RunStorePageReadResult<RunStoreAttemptPage>>;
  listOutputs(query: RunStoreOutputQuery): Promise<RunStorePageReadResult<RunStoreOutputPage>>;
  getIdempotency(
    identity: RunStoreIdempotencyIdentity,
  ): Promise<RunStoreLookupResult<RunStoreIdempotencyRecord>>;
  getHandoff(key: AttemptHandoffKey): Promise<RunStoreLookupResult<AttemptHandoffState>>;
  commit(command: RunStoreCommitCommand): Promise<RunStoreCommitResult>;
}
