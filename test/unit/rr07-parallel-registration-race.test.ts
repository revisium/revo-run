import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestWorkflow = (input: unknown) => Promise<unknown>;

const digest = (character: string): string => character.repeat(43);

const dbos = vi.hoisted(() => ({
  workflowID: `rr:scope:v2:sc1_${'a'.repeat(43)}`,
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
  startWorkflow:
    vi.fn<
      (
        workflow: TestWorkflow,
        options: Readonly<{ workflowID: string }>,
      ) => (input: unknown) => Promise<unknown>
    >(),
  waitFirst: vi.fn<(handles: readonly unknown[]) => Promise<unknown>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { RunCoordinatorV2Client } from '../../src/dbos/coordination/run-coordinator-v2-client.js';
import { DbosParallelBranchRunnerV2 } from '../../src/dbos/parallel/dbos-parallel-branch-runner-v2.js';
import { ParallelBranchWorkflowV2Provider } from '../../src/dbos/workflows/parallel-branch-workflow-v2-provider.js';
import type { PipelineExecutionContext } from '../../src/pipeline/interpreter/interpreter-context.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const context: PipelineExecutionContext = {
  plan: terminalExecutionPlan(),
  runId: 'registration-race',
  scopeId: `sc1_${digest('b')}`,
  runInput: null,
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main',
  outputs: new Map(),
  maximumParallelism: 1,
};

describe('RR-07 parallel-branch registration race', () => {
  beforeEach(() => {
    dbos.getWorkflowStatus.mockReset();
    dbos.recv.mockReset().mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValueOnce({
      kind: 'cancel',
    });
    dbos.send.mockReset().mockResolvedValue(undefined);
    dbos.startWorkflow.mockReset().mockImplementation((_workflow, options) => async () => ({
      workflowID: options.workflowID,
      getResult: async () => ({ status: 'cancelled', key: 'first' }),
    }));
    dbos.waitFirst.mockReset();
  });

  it('starts the registered deterministic child before draining a winning cancellation', async () => {
    const workflows = new ParallelBranchWorkflowV2Provider();
    workflows.register(async () => ({ status: 'cancelled', key: 'first' }));
    const runner = new DbosParallelBranchRunnerV2(
      workflows,
      new RunCoordinatorV2Client(context.runId),
    );

    await expect(
      runner.execute(
        [
          { key: 'first', node: { kind: 'end', status: 'succeeded', outcome: 'first' } },
          { key: 'second', node: { kind: 'end', status: 'succeeded', outcome: 'second' } },
        ],
        context,
        'main/work',
      ),
    ).rejects.toThrow('Run scope cancellation was requested.');

    expect(dbos.startWorkflow).toHaveBeenCalledOnce();
    expect(dbos.send.mock.invocationCallOrder[0]).toBeLessThan(
      dbos.startWorkflow.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(dbos.startWorkflow.mock.invocationCallOrder[0]).toBeLessThan(
      dbos.recv.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(dbos.recv.mock.calls).toStrictEqual([
      [expect.any(String), { timeoutSeconds: 86_400 }],
      [expect.any(String), { timeoutSeconds: 0 }],
    ]);
    expect(dbos.waitFirst).not.toHaveBeenCalled();
  });
});
