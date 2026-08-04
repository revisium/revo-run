import { afterEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  registrations: [] as string[],
  workflows: new Map<string, unknown>(),
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: <Arguments extends unknown[], Result>(
      workflow: (...arguments_: Arguments) => Promise<Result>,
      options: { name: string },
    ) => {
      dbos.registrations.push(options.name);
      dbos.workflows.set(options.name, workflow);
      return workflow;
    },
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
  },
}));

import {
  createWorkflowRuntime,
  type WorkflowRuntime,
} from '../../src/workflow/create-workflow-runtime.js';
import { WorkflowRegistrationHarness } from '../support/workflow-registration-harness.js';

const options = () => ({
  database: { url: 'postgresql://test' },
  plans: {
    loadExact: vi.fn<() => Promise<{ compiledPipeline: null }>>(async () => ({
      compiledPipeline: null,
    })),
  },
  executor: {
    execute: vi.fn<() => Promise<{ outcome: 'completed' }>>(async () => ({
      outcome: 'completed',
    })),
  },
  snapshots: {
    create: vi.fn<() => Promise<void>>(async () => undefined),
    update: vi.fn<() => Promise<void>>(async () => undefined),
    get: vi.fn<() => Promise<undefined>>(async () => undefined),
  },
});

const harness = new WorkflowRegistrationHarness(dbos.registrations, dbos.workflows);
const activeRuntimes: WorkflowRuntime[] = [];
const createRuntime = (dependencies = options()): WorkflowRuntime => {
  const runtime = createWorkflowRuntime(dependencies);
  activeRuntimes.push(runtime);
  return runtime;
};

afterEach(() => {
  for (const runtime of activeRuntimes.splice(0)) runtime.dispose();
});

describe('workflow registration and context', () => {
  it('registers each DBOS workflow once across runtime replacements', () => {
    createRuntime().dispose();
    createRuntime();

    expect(harness.registrations).toEqual([
      'revo-run.task.v1',
      'revo-run.candidate.v1',
      'revo-run.run.v1',
    ]);
  });

  it('rejects workflow dispatch after its context is disposed', async () => {
    const runtime = createRuntime();
    const task = harness.taskWorkflow();
    runtime.dispose();

    await expect(task('run-1', 'task', null)).rejects.toThrow(
      'Run manager workflow context is not active.',
    );
  });

  it('dispatches through replacement dependencies without using stale dependencies', async () => {
    const firstOptions = options();
    createRuntime(firstOptions).dispose();
    const secondOptions = options();
    createRuntime(secondOptions);
    const task = harness.taskWorkflow();

    await expect(task('run-2', 'task', null)).resolves.toBe('completed');

    expect(firstOptions.executor.execute).not.toHaveBeenCalled();
    expect(secondOptions.executor.execute).toHaveBeenCalledWith({
      runId: 'run-2',
      nodeKey: 'task',
      input: null,
    });
  });
});
