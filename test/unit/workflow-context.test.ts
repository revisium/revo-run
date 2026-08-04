import { describe, expect, it, vi } from 'vitest';

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

import { createWorkflowRuntime } from '../../src/workflow/create-workflow-runtime.js';
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

describe('workflow registration and context', () => {
  it('registers once and dispatches only through the currently bound dependencies', async () => {
    const harness = new WorkflowRegistrationHarness(dbos.registrations, dbos.workflows);
    const firstOptions = options();
    const first = createWorkflowRuntime(firstOptions);
    const task = harness.taskWorkflow();

    first.dispose();
    await expect(task('run-1', 'task', null)).rejects.toThrow(
      'Run manager workflow context is not active.',
    );

    const secondOptions = options();
    const second = createWorkflowRuntime(secondOptions);
    await expect(task('run-2', 'task', null)).resolves.toBe('completed');
    expect(firstOptions.executor.execute).not.toHaveBeenCalled();
    expect(secondOptions.executor.execute).toHaveBeenCalledWith({
      runId: 'run-2',
      nodeKey: 'task',
      input: null,
    });
    expect(harness.registrations).toEqual([
      'revo-run.task.v1',
      'revo-run.candidate.v1',
      'revo-run.run.v1',
    ]);

    second.dispose();
  });
});
