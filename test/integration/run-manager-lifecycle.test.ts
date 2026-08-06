import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { noopRunExecutor } from '../support/executor/noop-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('run manager lifecycle', () => {
  it('starts again after shutdown', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: noopRunExecutor,
    });

    await expect(manager.start()).resolves.toBeUndefined();
    await manager.stop();
    await expect(manager.start()).resolves.toBeUndefined();
  });

  it('shares one runtime launch across concurrent starts', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: noopRunExecutor,
    });

    await expect(Promise.all([manager.start(), manager.start()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it('completes a stop requested while the runtime is starting', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: noopRunExecutor,
    });

    const starting = manager.start();
    const stopping = manager.stop();
    await expect(Promise.all([starting, stopping])).resolves.toEqual([undefined, undefined]);

    await expect(manager.getRun('after-stop')).rejects.toThrow('Run manager is not started.');
    await expect(manager.start()).resolves.toBeUndefined();
  });
});
