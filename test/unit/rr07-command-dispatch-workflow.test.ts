import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  retrieveWorkflow:
    vi.fn<(workflowId: string) => { getWorkflowInputs: () => Promise<unknown[]> }>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { runCoordinatorV2Topic } from '../../src/dbos/dbos-names.js';
import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import { commandOrphanHealthCheckSeconds } from '../../src/dbos/workflows/command-dispatch-workflow.js';
import { createCommandDispatchWorkflow } from '../../src/dbos/workflows/command-dispatch-workflow.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const commandId = 'cmd_00000000-0000-4000-8000-000000000001';
const input = {
  commandId,
  command: { kind: 'cancelRun' as const, input: { runId: 'run-1', actorId: 'operator' } },
};
const status = (workflowName: string, state: string) => ({
  workflowName,
  status: state,
});
const accepted = {
  status: 'receipt' as const,
  receipt: { status: 'accepted' as const, commandId },
};
const validRootInput = {
  runId: 'run-1',
  admissionToken: 'A'.repeat(43),
  executionPlan: terminalExecutionPlan(),
  input: null,
};

describe('RR-07 command dispatcher terminal races', () => {
  beforeEach(() => {
    dbos.getWorkflowStatus.mockReset();
    dbos.recv.mockReset();
    dbos.retrieveWorkflow.mockReset().mockReturnValue({
      getWorkflowInputs: async () => [validRootInput],
    });
    dbos.send.mockReset().mockResolvedValue(undefined);
  });

  it('does not send commands to a v1 root', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(status('revo-run.run.v1', 'PENDING'));

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'receipt',
      receipt: { status: 'rejected', commandId, reason: 'unsupported_run_version' },
    });
    expect(dbos.send).not.toHaveBeenCalled();
    expect(dbos.recv).not.toHaveBeenCalled();
  });

  it('rejects a terminal v2 root without appending or sending', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(status('revo-run.run.v2', 'SUCCESS'));

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'receipt',
      receipt: { status: 'rejected', commandId, reason: 'run_already_terminal' },
    });
    expect(dbos.send).not.toHaveBeenCalled();
    expect(dbos.recv).not.toHaveBeenCalled();
  });

  it('fails dispatch for malformed durable input in a terminal exact-name v2 root', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(status('revo-run.run.v2', 'SUCCESS'));
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => [{ runId: 'run-1' }],
    });

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'dispatchFailed',
      commandId,
    });
    expect(dbos.send).not.toHaveBeenCalled();
    expect(dbos.recv).not.toHaveBeenCalled();
  });

  it('fails dispatch for a terminal exact-name v2 root owned by another run', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(status('revo-run.run.v2', 'SUCCESS'));
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => [{ ...validRootInput, runId: 'another-run' }],
    });

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'dispatchFailed',
      commandId,
    });
    expect(dbos.send).not.toHaveBeenCalled();
    expect(dbos.recv).not.toHaveBeenCalled();
  });

  it('fails dispatch for an active named v2 root with malformed durable input', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(status('revo-run.run.v2', 'PENDING'));
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => [{ runId: 'run-1' }],
    });

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'dispatchFailed',
      commandId,
    });
    expect(dbos.send).not.toHaveBeenCalled();
    expect(dbos.recv).not.toHaveBeenCalled();
  });

  it('fails dispatch when valid durable v2 input belongs to another run', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(status('revo-run.run.v2', 'PENDING'));
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => [{ ...validRootInput, runId: 'another-run' }],
    });

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'dispatchFailed',
      commandId,
    });
    expect(dbos.send).not.toHaveBeenCalled();
    expect(dbos.recv).not.toHaveBeenCalled();
  });

  it('does not treat an active foreign workflow in the permanent root slot as a run', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(status('foreign.workflow', 'PENDING'));

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'runNotFound',
      commandId,
    });
    expect(dbos.retrieveWorkflow).not.toHaveBeenCalled();
    expect(dbos.send).not.toHaveBeenCalled();
    expect(dbos.recv).not.toHaveBeenCalled();
  });

  it('returns the committed receipt from the final drain after root settlement', async () => {
    dbos.getWorkflowStatus
      .mockResolvedValueOnce(status('revo-run.run.v2', 'PENDING'))
      .mockResolvedValueOnce(status('revo-run.run.v2', 'SUCCESS'));
    dbos.recv.mockResolvedValueOnce(null).mockResolvedValueOnce(accepted);

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual(accepted);
    expect(dbos.send).toHaveBeenCalledOnce();
    expect(dbos.send).toHaveBeenCalledWith(runWorkflowId('run-1'), input, runCoordinatorV2Topic);
    expect(dbos.recv).toHaveBeenCalledTimes(2);
    expect(dbos.recv).toHaveBeenLastCalledWith(expect.any(String), { timeoutSeconds: 0 });
  });

  it('uses one short race receive before notification-first orphan cadence', async () => {
    dbos.getWorkflowStatus
      .mockResolvedValueOnce(status('revo-run.run.v2', 'PENDING'))
      .mockResolvedValueOnce(status('revo-run.run.v2', 'PENDING'));
    dbos.recv.mockResolvedValueOnce(null).mockResolvedValueOnce(accepted);

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual(accepted);

    expect(dbos.recv.mock.calls).toStrictEqual([
      [expect.any(String), { timeoutSeconds: 1 }],
      [expect.any(String), { timeoutSeconds: commandOrphanHealthCheckSeconds }],
    ]);
    expect(dbos.getWorkflowStatus).toHaveBeenCalledTimes(2);
  });

  it('rejects only when a terminal root has no committed final reply', async () => {
    dbos.getWorkflowStatus
      .mockResolvedValueOnce(status('revo-run.run.v2', 'PENDING'))
      .mockResolvedValueOnce(status('revo-run.run.v2', 'SUCCESS'));
    dbos.recv.mockResolvedValue(null);

    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'receipt',
      receipt: { status: 'rejected', commandId, reason: 'run_already_terminal' },
    });
  });

  it('distinguishes an absent root from an owned terminal run', async () => {
    dbos.getWorkflowStatus.mockResolvedValue(null);
    await expect(createCommandDispatchWorkflow()(input)).resolves.toEqual({
      status: 'runNotFound',
      commandId,
    });
  });
});
