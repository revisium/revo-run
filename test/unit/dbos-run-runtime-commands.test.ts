import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestWorkflow = (input: unknown) => Promise<unknown>;

const commandIdFactory = vi.hoisted(() =>
  vi.fn<() => `${string}-${string}-${string}-${string}-${string}`>(),
);
const dbos = vi.hoisted(() => ({
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  registerWorkflow: vi.fn<(workflow: TestWorkflow) => TestWorkflow>((workflow) => workflow),
  retrieveWorkflow:
    vi.fn<(workflowId: string) => { getWorkflowInputs: () => Promise<unknown[]> }>(),
  startWorkflow: vi.fn<() => () => Promise<unknown>>(),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: commandIdFactory };
});

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { runWorkflowName } from '../../src/dbos/dbos-names.js';
import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { commandWorkflowId } from '../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import { noopRunExecutor } from '../support/executor/noop-run-executor.js';

const runtime = () =>
  new DbosRunRuntime('postgres://unused', noopRunExecutor, new WorkflowRegistry());

describe('DBOS public command identity admission', () => {
  beforeEach(() => {
    commandIdFactory.mockReset().mockReturnValue('00000000-0000-4000-8000-000000000001');
    dbos.getWorkflowStatus.mockReset();
    dbos.registerWorkflow.mockReset().mockImplementation((workflow) => workflow);
    dbos.retrieveWorkflow.mockReset();
    dbos.startWorkflow.mockReset();
  });

  it('returns run_not_found before allocating an ID or creating a command workflow', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(null);

    await expect(
      runtime().cancelRun({ runId: 'missing-run', actorId: 'operator' }),
    ).rejects.toMatchObject({ code: 'run_not_found', commandId: undefined });

    expect(commandIdFactory).not.toHaveBeenCalled();
    expect(dbos.startWorkflow).not.toHaveBeenCalled();
  });

  it('preserves the generated ID when delivery becomes indeterminate after a nonmissing precheck', async () => {
    dbos.getWorkflowStatus.mockResolvedValue({
      workflowName: runWorkflowName,
      status: 'PENDING',
    });
    dbos.startWorkflow.mockReturnValue(() => Promise.reject(new Error('delivery indeterminate')));

    await expect(
      runtime().cancelRun({ runId: 'owned-run', actorId: 'operator' }),
    ).rejects.toMatchObject({
      code: 'run_command_failed',
      commandId: 'cmd_00000000-0000-4000-8000-000000000001',
    });

    expect(commandIdFactory).toHaveBeenCalledOnce();
  });

  it('maps an internal dispatch failure to run_command_failed with the allocated command ID', async () => {
    const commandId = 'cmd_00000000-0000-4000-8000-000000000001';
    const durableInput = {
      commandId,
      command: {
        kind: 'cancelRun' as const,
        input: { runId: 'owned-run', actorId: 'operator' },
      },
    };
    dbos.getWorkflowStatus.mockResolvedValue({
      workflowName: runWorkflowName,
      status: 'PENDING',
    });
    dbos.startWorkflow.mockReturnValue(() =>
      Promise.resolve({
        getResult: async () => ({ status: 'dispatchFailed', commandId }),
      }),
    );
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => [durableInput],
    });

    await expect(
      runtime().cancelRun({ runId: 'owned-run', actorId: 'operator' }),
    ).rejects.toMatchObject({ code: 'run_command_failed', commandId });

    expect(dbos.retrieveWorkflow).toHaveBeenCalledWith(commandWorkflowId(commandId));
  });

  it('routes a recorded current command through its canonical identity', async () => {
    const commandId = 'cmd_00000000-0000-4000-8000-000000000001';
    const command = {
      kind: 'cancelRun' as const,
      input: { runId: 'current-run', actorId: 'operator' },
    };
    const durableInput = { commandId, command };
    dbos.getWorkflowStatus.mockResolvedValue({ workflowName: runWorkflowName, status: 'PENDING' });
    dbos.startWorkflow.mockReturnValue(() =>
      Promise.resolve({
        getResult: async () => ({
          status: 'receipt',
          receipt: { status: 'accepted', commandId },
        }),
      }),
    );
    dbos.retrieveWorkflow.mockReturnValue({ getWorkflowInputs: async () => [durableInput] });

    await expect(runtime().dispatchCommand(command, commandId)).resolves.toEqual({
      status: 'accepted',
      commandId,
    });
    expect(dbos.startWorkflow).toHaveBeenCalledWith(expect.any(Function), {
      workflowID: commandWorkflowId(commandId),
    });
    expect(dbos.retrieveWorkflow).toHaveBeenCalledWith(commandWorkflowId(commandId));
  });

  it('uses the sole dispatcher and reports its failure for an unknown recorded root workflow', async () => {
    const commandId = 'cmd_00000000-0000-4000-8000-000000000001';
    dbos.getWorkflowStatus.mockResolvedValue({ workflowName: 'foreign.run', status: 'PENDING' });

    await expect(
      runtime().dispatchCommand(
        {
          kind: 'cancelRun',
          input: { runId: 'foreign-run', actorId: 'operator' },
        },
        commandId,
      ),
    ).rejects.toMatchObject({ code: 'run_command_failed', commandId });
    expect(dbos.startWorkflow).toHaveBeenCalledWith(expect.any(Function), {
      workflowID: commandWorkflowId(commandId),
    });
  });
});
