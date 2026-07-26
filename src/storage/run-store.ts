import type { Run } from '../domain/index.js';
import type { RunStoreDiscoveryPage } from './run-store-discovery-page.js';
import type { RunStoreDiscoveryQuery } from './run-store-discovery-query.js';
import type { RunStoreEventPage } from './run-store-event-page.js';
import type { RunStoreEventQuery } from './run-store-event-query.js';
import type { RunStoreListRunsQuery } from './run-store-list-runs-query.js';
import type { RunStoreLookupResult } from './run-store-lookup-result.js';
import type { RunStorePageReadResult } from './run-store-page-read-result.js';
import type { RunStoreRunPage } from './run-store-run-page.js';
import type { RunStoreTransaction } from './run-store-transaction.js';

export interface RunStore {
  transaction<Result>(
    callback: (transaction: RunStoreTransaction) => Promise<Result>,
  ): Promise<Result>;
  discover(query: RunStoreDiscoveryQuery): Promise<RunStorePageReadResult<RunStoreDiscoveryPage>>;
  getRun(runId: string): Promise<RunStoreLookupResult<Run>>;
  listRuns(query: RunStoreListRunsQuery): Promise<RunStorePageReadResult<RunStoreRunPage>>;
  readEvents(query: RunStoreEventQuery): Promise<RunStorePageReadResult<RunStoreEventPage>>;
}
