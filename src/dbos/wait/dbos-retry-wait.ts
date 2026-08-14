import { DBOS } from '@dbos-inc/dbos-sdk';

import type { WaitForRetry } from '../../pipeline/interpreter/interpreter-context.js';

export const waitForDurableRetry: WaitForRetry = async (_request, delayMs) => {
  await DBOS.sleep(delayMs);
};
