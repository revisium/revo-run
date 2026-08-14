import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  runStep: vi.fn<(callback: () => unknown, options?: unknown) => Promise<unknown>>(),
  sleep: vi.fn<(delayMs: number) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import type { RunExecutorRequest } from '../../src/contracts/executor/run-executor.js';
import { waitForDurableRetry } from '../../src/dbos/wait/dbos-retry-wait.js';

const request: RunExecutorRequest = {
  runId: 'run-1',
  scopeId: `sc1_${'b'.repeat(43)}`,
  authoredNodeId: `an1_${'c'.repeat(43)}`,
  nodeInstanceId: `ni1_${'d'.repeat(43)}`,
  attemptId: `at1_${'a'.repeat(43)}`,
  attemptOrdinal: 1,
  displayPath: 'main/work',
  pipelineId: 'main',
  nodePath: 'work',
  binding: {
    kind: 'script',
    target: { pipelineId: 'main', nodePath: 'work' },
    script: { id: 'effect.run', revision: 1 },
  },
  input: {},
};

describe('durable retry wait', () => {
  beforeEach(() => {
    dbos.runStep.mockReset().mockImplementation(async (callback) => callback());
    dbos.sleep.mockReset().mockResolvedValue(undefined);
  });

  it('preserves the frozen sleep-only durable function order', async () => {
    await waitForDurableRetry(request, 5_000);

    expect(dbos.runStep).not.toHaveBeenCalled();
    expect(dbos.sleep).toHaveBeenCalledWith(5_000);
  });
});
