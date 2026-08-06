import { DbosRuntime } from '../runtime/dbos-runtime.js';
import { DbosWorkflowRegistry } from '../runtime/dbos-workflow-registry.js';
import { RunManager } from './run-manager.js';

let workflows: DbosWorkflowRegistry | undefined;

const getWorkflows = (): DbosWorkflowRegistry => {
  workflows ??= new DbosWorkflowRegistry();
  return workflows;
};

export const createRunManager = (options: {
  readonly database: {
    readonly url: string;
  };
}): RunManager => new RunManager(new DbosRuntime(options.database.url, getWorkflows().run));
