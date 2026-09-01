import { expect, it, vi } from 'vitest';

import { waitForCoordinatorMessage } from '../../src/dbos/coordinator-inbox.js';

it('continues waiting when a coordinator receive window expires', async () => {
  const message = Object.freeze({ kind: 'terminal' });
  const receive = vi
    .fn<() => Promise<typeof message | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(message);

  await expect(waitForCoordinatorMessage(receive)).resolves.toBe(message);
  expect(receive).toHaveBeenCalledTimes(2);
});
