import type { CreateRunManagerOptions, RunManager as RunManagerContract } from '../types.js';
import { createWorkflowRuntime } from '../workflow/create-workflow-runtime.js';
import { acquireProcessManagerOwnership } from './process-manager-ownership.js';
import { RunManager } from './run-manager.js';

type WorkflowRuntimeFactory = typeof createWorkflowRuntime;

export const createRunManagerWithRuntimeFactory = (
  options: CreateRunManagerOptions,
  createRuntime: WorkflowRuntimeFactory,
): RunManagerContract => {
  const ownership = acquireProcessManagerOwnership();
  try {
    const runtime = createRuntime(options);
    return new RunManager(runtime, ownership, options.snapshots);
  } catch (error: unknown) {
    ownership.release();
    throw error;
  }
};

export const createRunManager = (options: CreateRunManagerOptions): RunManagerContract =>
  createRunManagerWithRuntimeFactory(options, createWorkflowRuntime);
