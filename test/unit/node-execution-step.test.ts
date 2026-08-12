import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunNodeExecution } from '../../src/contracts/executor/run-node-execution.js';
import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import { NodeExecutionStep } from '../../src/dbos/steps/node-execution-step.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('node execution DBOS step', () => {
  it('disables DBOS retries for every logical attempt', async () => {
    const execution: RunNodeExecution = storedNodeExecution('main/root-work', 'completed', 2);
    const runStep = vi.spyOn(DBOS, 'runStep').mockResolvedValue(execution);
    const step = new NodeExecutionStep(new RunExecutorProvider());

    await expect(step.execute(execution.request, 1_500)).resolves.toBe(execution);
    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0]?.[1]).toEqual({
      name: 'execute-node-attempt:2:main/root-work',
      retriesAllowed: false,
      timeoutMS: 1_500,
    });
  });
});
