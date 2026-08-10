import type { RunExecutor } from '../contracts/executor/run-executor.js';
import { DbosRunRuntime } from '../dbos/dbos-run-runtime.js';
import { WorkflowRegistry } from '../dbos/workflow-registry.js';
import { RunManager } from './run-manager.js';

export interface CreateRunManagerOptions {
  readonly database: {
    readonly url: string;
  };
  readonly executor: RunExecutor;
}

// DBOS workflow registration is process-global and must happen only once per process.
let workflows: WorkflowRegistry | undefined;

const getWorkflows = (): WorkflowRegistry => {
  workflows ??= new WorkflowRegistry();
  return workflows;
};

export const createRunManager = (options: CreateRunManagerOptions): RunManager =>
  new RunManager(new DbosRunRuntime(options.database.url, options.executor, getWorkflows()));
