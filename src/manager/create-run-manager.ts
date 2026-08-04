import type { CreateRunManagerOptions, RunManager as RunManagerContract } from '../types.js';
import { createWorkflowRuntime } from '../workflow/create-workflow-runtime.js';
import { acquireProcessManagerOwnership } from './process-manager-ownership.js';
import { RunManagerController } from './run-manager.js';

type WorkflowRuntimeFactory = typeof createWorkflowRuntime;

export const createRunManagerWithRuntimeFactory = (
  options: CreateRunManagerOptions,
  createRuntime: WorkflowRuntimeFactory,
): RunManagerContract => {
  const ownership = acquireProcessManagerOwnership();
  try {
    const runtime = createRuntime(options);
    const controller = new RunManagerController(runtime, ownership, options.snapshots);
    return Object.freeze({
      start: () => controller.start(),
      stop: () => controller.stop(),
      startRun: (request: Parameters<RunManagerContract['startRun']>[0]) =>
        controller.startRun(request),
      getRun: (runId: string) => controller.getRun(runId),
    });
  } catch (error: unknown) {
    ownership.release();
    throw error;
  }
};

export const createRunManager = (options: CreateRunManagerOptions): RunManagerContract =>
  createRunManagerWithRuntimeFactory(options, createWorkflowRuntime);
