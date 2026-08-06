import { DbosRuntime } from '../runtime/dbos-runtime.js';
import { DbosWorkflowRegistry } from '../runtime/dbos-workflow-registry.js';
import { RunManager } from './run-manager.js';

const workflows = new DbosWorkflowRegistry();

export const createRunManager = (options: {
  readonly database: {
    readonly url: string;
  };
}): RunManager => new RunManager(new DbosRuntime(options.database.url, workflows.run));
