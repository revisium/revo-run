import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunExecutor } from '../../src/index.js';

type TestWorkflow = (input: unknown) => Promise<unknown>;

const dbos = vi.hoisted(() => ({
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  registerWorkflow: vi.fn<(workflow: TestWorkflow) => TestWorkflow>((workflow) => workflow),
  startWorkflow:
    vi.fn<
      (
        workflow: TestWorkflow,
        options: Readonly<Record<string, unknown>>,
      ) => (input: unknown) => Promise<unknown>
    >(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import { executionPlan, scriptBinding, task } from '../dsl/pipeline-builder.js';

const runId = 'Recovery_1';

const planWithRecovery = (unknownOutcome: 'fail' | 'requireHumanResolution') =>
  executionPlan(
    task('work', {
      recovery: {
        reconciliation: 'required',
        maximumAttempts: 2,
        timeoutMs: 1_000,
        unknownOutcome,
      },
    }),
    { bindings: [scriptBinding('work', 'effect.run')] },
  );

const executor = (reconciliation: 'absent' | 'available') => {
  const execute = vi.fn<RunExecutor['execute']>(async () => ({
    kind: 'failed',
    error: { code: 'executor_unavailable', message: 'No test executor is configured.' },
  }));
  const reconcile = vi.fn<NonNullable<RunExecutor['reconcile']>>(async () => ({
    kind: 'outcomeUnknown',
  }));
  return {
    execute,
    reconcile,
    value: reconciliation === 'available' ? { execute, reconcile } : { execute },
  };
};

describe('DBOS recovery admission', () => {
  beforeEach(() => {
    dbos.getWorkflowStatus.mockReset();
    dbos.registerWorkflow.mockReset().mockImplementation((workflow) => workflow);
    dbos.startWorkflow.mockReset();
  });

  it('rejects required reconciliation when the executor cannot reconcile before DBOS access', async () => {
    const provider = executor('absent');
    const runtime = new DbosRunRuntime('postgres://unused', provider.value, new WorkflowRegistry());

    await expect(runtime.startRun(runId, planWithRecovery('fail'), null)).rejects.toMatchObject({
      code: 'recovery_reconcile_required',
    });
    expect(dbos.getWorkflowStatus).not.toHaveBeenCalled();
    expect(dbos.startWorkflow).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('rejects human resolution before DBOS or provider access', async () => {
    const provider = executor('available');
    const runtime = new DbosRunRuntime('postgres://unused', provider.value, new WorkflowRegistry());

    await expect(
      runtime.startRun(runId, planWithRecovery('requireHumanResolution'), null),
    ).rejects.toMatchObject({
      code: 'recovery_human_resolution_unsupported',
      message: 'Human resolution recovery is not supported.',
    });
    expect(dbos.getWorkflowStatus).not.toHaveBeenCalled();
    expect(dbos.startWorkflow).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(provider.reconcile).not.toHaveBeenCalled();
  });
});
