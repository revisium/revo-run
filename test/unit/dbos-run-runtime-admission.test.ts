import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestWorkflow = (input: unknown) => Promise<unknown>;
type TestStatus = {
  readonly applicationID: string;
  readonly workflowID: string;
  readonly workflowName: string;
  readonly workflowClassName: string;
  readonly priority: number;
  readonly status: string;
  readonly input: readonly unknown[];
  readonly output: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
};

const dbos = vi.hoisted(() => ({
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<TestStatus | null>>(),
  readStream: vi.fn<(workflowId: string, streamKey: string) => AsyncIterable<unknown>>(),
  registerWorkflow: vi.fn<(workflow: TestWorkflow) => TestWorkflow>((workflow) => workflow),
  retrieveWorkflow:
    vi.fn<
      (workflowId: string) => { readonly getWorkflowInputs: () => Promise<readonly unknown[]> }
    >(),
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

import { runWorkflowName } from '../../src/dbos/dbos-names.js';
import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';
import { noopRunExecutor } from '../support/executor/noop-run-executor.js';

const runId = 'Race_1';
const rootWorkflowId = 'rr:run:v2:Race_1';
const executionPlan = terminalExecutionPlan();
const admissionToken = 'a'.repeat(43);

const durableInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  contractVersion: 2,
  runId,
  admissionToken,
  executionPlan,
  input: null,
  ...overrides,
});

const status = (
  input: readonly unknown[] = [durableInput()],
  workflowName = runWorkflowName,
): TestStatus => ({
  applicationID: 'test',
  workflowID: rootWorkflowId,
  workflowName,
  status: 'PENDING',
  input,
  output: undefined,
  createdAt: 1,
  updatedAt: 1,
  workflowClassName: '',
  priority: 0,
});

const runtime = () =>
  new DbosRunRuntime('postgres://unused', noopRunExecutor, new WorkflowRegistry());

describe('DBOS create-only run admission', () => {
  beforeEach(() => {
    dbos.getWorkflowStatus.mockReset();
    dbos.readStream.mockReset();
    dbos.registerWorkflow.mockReset().mockImplementation((workflow) => workflow);
    dbos.retrieveWorkflow.mockReset();
    dbos.startWorkflow.mockReset();
  });

  it('starts the mapped root without duplication policy and confirms its private token', async () => {
    let startedInput: unknown;
    dbos.getWorkflowStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(status());
    dbos.startWorkflow.mockReturnValue(async (input) => {
      startedInput = input;
      return {};
    });
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => [startedInput],
    });

    await expect(runtime().startRun(runId, executionPlan, null)).resolves.toBeUndefined();

    expect(dbos.getWorkflowStatus).toHaveBeenNthCalledWith(1, rootWorkflowId);
    expect(dbos.startWorkflow).toHaveBeenCalledWith(expect.any(Function), {
      workflowID: rootWorkflowId,
    });
    expect(startedInput).toMatchObject({ contractVersion: 2, runId, executionPlan, input: null });
    expect(startedInput).toHaveProperty('admissionToken', expect.stringMatching(/^[\w-]{43}$/));
    expect(dbos.retrieveWorkflow).toHaveBeenCalledWith(rootWorkflowId);
  });

  it('rejects any already claimed run ID before starting or retrieving inputs', async () => {
    dbos.getWorkflowStatus.mockResolvedValueOnce(status());

    await expect(runtime().startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_id_conflict',
    });
    expect(dbos.startWorkflow).not.toHaveBeenCalled();
    expect(dbos.retrieveWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a silent attach when another admission token won', async () => {
    dbos.getWorkflowStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(status());
    dbos.startWorkflow.mockReturnValue(async () => ({}));
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => [durableInput()],
    });

    await expect(runtime().startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_id_conflict',
    });
  });

  it('maps an unavailable precheck to admission failure', async () => {
    dbos.getWorkflowStatus.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(runtime().startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_admission_failed',
    });
    expect(dbos.startWorkflow).not.toHaveBeenCalled();
  });

  it('fails when a successful start cannot be confirmed', async () => {
    dbos.getWorkflowStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    dbos.startWorkflow.mockReturnValue(async () => ({}));

    await expect(runtime().startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_admission_failed',
    });
  });

  it('maps unavailable durable inputs to admission failure', async () => {
    dbos.getWorkflowStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(status());
    dbos.startWorkflow.mockReturnValue(async () => ({}));
    dbos.retrieveWorkflow.mockReturnValue({
      getWorkflowInputs: async () => Promise.reject(new Error('database unavailable')),
    });

    await expect(runtime().startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_admission_failed',
    });
  });

  it.each([
    ['foreign workflow', [durableInput()], 'foreign.workflow.v1'],
    ['missing token', [{ contractVersion: 2, runId, executionPlan, input: null }], runWorkflowName],
    ['extra property', [durableInput({ extra: true })], runWorkflowName],
    ['wrong contract version', [durableInput({ contractVersion: 1 })], runWorkflowName],
    ['stored run ID mismatch', [durableInput({ runId: 'Other_1' })], runWorkflowName],
  ])('maps %s after start to conflict', async (_label, inputs, workflowName) => {
    dbos.getWorkflowStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(status(inputs, workflowName));
    dbos.startWorkflow.mockReturnValue(async () => ({}));
    dbos.retrieveWorkflow.mockReturnValue({ getWorkflowInputs: async () => inputs });

    await expect(runtime().startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_id_conflict',
    });
  });

  it('recovers a throw-after-commit only when its token owns the durable input', async () => {
    let startedInput: unknown;
    dbos.getWorkflowStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(status());
    dbos.startWorkflow.mockReturnValue(async (input) => {
      startedInput = input;
      throw new Error('response lost after commit');
    });
    dbos.retrieveWorkflow.mockReturnValue({ getWorkflowInputs: async () => [startedInput] });

    await expect(runtime().startRun(runId, executionPlan, null)).resolves.toBeUndefined();
  });

  it('allows recovery through getRun after an unconfirmable post-commit response', async () => {
    let startedInput: unknown;
    dbos.getWorkflowStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => status([startedInput]))
      .mockImplementationOnce(async () => status([startedInput]));
    dbos.startWorkflow.mockReturnValue(async (input) => {
      startedInput = input;
      return {};
    });

    const subject = runtime();
    await expect(subject.startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_admission_failed',
    });
    await expect(subject.getRun(runId)).resolves.toMatchObject({ id: runId, input: null });
    await expect(subject.startRun(runId, executionPlan, null)).rejects.toMatchObject({
      code: 'run_id_conflict',
    });
  });
});

describe('DBOS mapped run reads', () => {
  beforeEach(() => {
    dbos.getWorkflowStatus.mockReset();
    dbos.registerWorkflow.mockReset().mockImplementation((workflow) => workflow);
  });

  it('maps transient status reads to run_read_failed', async () => {
    dbos.getWorkflowStatus.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(runtime().getRun(runId)).rejects.toMatchObject({ code: 'run_read_failed' });
  });

  it('returns undefined when the workflow status is missing', async () => {
    dbos.getWorkflowStatus.mockResolvedValueOnce(null);

    await expect(runtime().getRun(runId)).resolves.toBeUndefined();
  });

  it.each([
    ['foreign workflow', status([durableInput()], 'foreign.workflow.v1')],
    ['mapped workflow ID mismatch', { ...status(), workflowID: 'rr:run:v2:Other_1' }],
    ['stored run ID mismatch', status([durableInput({ runId: 'Other_1' })])],
  ])('treats %s as not found', async (_label, workflowStatus) => {
    dbos.getWorkflowStatus.mockResolvedValueOnce(workflowStatus);
    await expect(runtime().getRun(runId)).resolves.toBeUndefined();
  });

  it('maps malformed arguments to run_read_failed for an owned workflow', async () => {
    const workflowStatus = status([{ contractVersion: 2 }]);
    dbos.getWorkflowStatus.mockResolvedValueOnce(workflowStatus);
    await expect(runtime().getRun(runId)).rejects.toMatchObject({ code: 'run_read_failed' });
  });

  it.each([
    ['an unknown DBOS status', { ...status(), status: 'UNKNOWN' }],
    ['a malformed successful output', { ...status(), status: 'SUCCESS', output: null }],
  ])('maps %s to run_read_failed after ownership is proven', async (_label, workflowStatus) => {
    dbos.getWorkflowStatus.mockResolvedValueOnce(workflowStatus);
    await expect(runtime().getRun(runId)).rejects.toMatchObject({ code: 'run_read_failed' });
  });
});
