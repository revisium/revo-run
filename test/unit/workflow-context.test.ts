import { afterEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => {
  let currentWorkflowId: string | undefined = 'run-id';
  return {
    registrations: [] as string[],
    workflows: new Map<string, unknown>(),
    currentWorkflowId: () => currentWorkflowId,
    setCurrentWorkflowId: (value: string | undefined) => {
      currentWorkflowId = value;
    },
  };
});

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    get workflowID() {
      return dbos.currentWorkflowId();
    },
    registerWorkflow: <Arguments extends unknown[], Result>(
      workflow: (...arguments_: Arguments) => Promise<Result>,
      options: { name: string },
    ) => {
      dbos.registrations.push(options.name);
      dbos.workflows.set(options.name, workflow);
      return workflow;
    },
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
    sleepms: vi.fn<(duration: number) => Promise<void>>(),
  },
}));

import type { RunExecutor } from '../../src/types.js';
import {
  createWorkflowRuntime,
  type WorkflowRuntime,
} from '../../src/workflow/create-workflow-runtime.js';
import { taskExecutionPlan } from '../support/execution-plan.js';
import { WorkflowRegistrationHarness } from '../support/workflow-registration-harness.js';

const options = () => {
  const execute = vi.fn<RunExecutor['execute']>(async () => ({
    completion: { kind: 'task' },
    status: 'completed',
  }));
  return {
    database: { url: 'postgresql://test' },
    execute,
    executor: {
      cancel: vi.fn<RunExecutor['cancel']>(async () => ({ status: 'not_supported' })),
      execute,
      reconcile: vi.fn<RunExecutor['reconcile']>(async () => ({ status: 'not_found' })),
    } satisfies RunExecutor,
  };
};
const harness = new WorkflowRegistrationHarness(dbos.registrations, dbos.workflows);
const activeRuntimes: WorkflowRuntime[] = [];
const createRuntime = (dependencies = options()): WorkflowRuntime => {
  const runtime = createWorkflowRuntime(dependencies);
  activeRuntimes.push(runtime);
  return runtime;
};

afterEach(() => {
  for (const runtime of activeRuntimes.splice(0)) {
    runtime.dispose();
  }
  dbos.setCurrentWorkflowId('run-id');
});

describe('workflow registration and context', () => {
  it('registers only the v2 DBOS workflow once across runtime replacements', () => {
    createRuntime().dispose();
    createRuntime();

    expect(harness.registrations).toEqual(['revo-run.run.v2']);
  });

  it('fails execution immediately after its workflow context is disposed', async () => {
    const runtime = createRuntime();
    const run = harness.runWorkflow();
    runtime.dispose();

    await expect(run(taskExecutionPlan, null)).rejects.toThrow(
      'Run manager workflow context is not active.',
    );
  });

  it('dispatches through replacement dependencies without stale plan sources or stores', async () => {
    const firstOptions = options();
    createRuntime(firstOptions).dispose();
    const secondOptions = options();
    createRuntime(secondOptions);
    const run = harness.runWorkflow();

    await expect(run(taskExecutionPlan, { value: 'input' })).resolves.toMatchObject({
      status: 'succeeded',
    });

    expect(firstOptions.execute).not.toHaveBeenCalled();
    expect(secondOptions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: { value: 'input' }, kind: 'task' }),
    );
  });

  it('rejects direct execution without a DBOS workflow ID', async () => {
    createRuntime();
    dbos.setCurrentWorkflowId(undefined);

    await expect(harness.runWorkflow()(taskExecutionPlan, null)).rejects.toThrow(
      'no DBOS workflow ID',
    );
  });
});
