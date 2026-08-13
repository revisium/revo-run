import type { WaitForUnknownOutcome } from './interpreter-context.js';

/** V1 has no durable command protocol; admission guarantees this fail-closed port is unreachable. */
export const rejectUnsupportedUnknownOutcomeResolution: WaitForUnknownOutcome = async () => {
  throw new Error('V1 unknown-outcome resolution is unsupported.');
};
