import { DBOS } from '@dbos-inc/dbos-sdk';

import type { WaitForRetry } from '../../pipeline/interpreter/interpreter-context.js';

/** Frozen v1 history: this port must remain a single durable sleep. */
export const waitForDurableRetryV1: WaitForRetry = async (_request, delayMs) => {
  await DBOS.sleep(delayMs);
};
