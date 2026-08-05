import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('run manager lifecycle', () => {
  it('starts again after shutdown', async () => {
    manager = createRunManager({ database: { url: testDatabaseUrl() } });

    await expect(manager.start()).resolves.toBeUndefined();
    await manager.stop();
    await expect(manager.start()).resolves.toBeUndefined();
  });
});
