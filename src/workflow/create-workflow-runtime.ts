import { isDeepStrictEqual } from 'node:util';

import { DBOS } from '@dbos-inc/dbos-sdk';
import type { JsonValue } from '@revisium/revo-pipeline';

import type { CreateRunManagerOptions, ExecutionPlan, RunSnapshot } from '../types.js';
import { mapWorkflowStatus } from './map-workflow-status.js';
import { registerWorkflows, RUN_WORKFLOW_NAME } from './register-workflows.js';
import { bindWorkflowContext } from './workflow-context.js';

const APPLICATION_NAME = 'revo-run';

interface AdmissionStatus {
  readonly input?: unknown[];
  readonly workflowName: string;
}

const matchesAdmission = (
  status: AdmissionStatus | null,
  executionPlan: ExecutionPlan,
  input: JsonValue,
): boolean =>
  status !== null &&
  status.workflowName === RUN_WORKFLOW_NAME &&
  status.input?.length === 2 &&
  isDeepStrictEqual(status.input[0], executionPlan) &&
  isDeepStrictEqual(status.input[1], input);

export interface WorkflowRuntime {
  configure(): void;
  launch(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): void;
  submit(runId: string, executionPlan: ExecutionPlan, input: JsonValue): Promise<void>;
  get(runId: string): Promise<RunSnapshot | undefined>;
}

export const createWorkflowRuntime = (dependencies: CreateRunManagerOptions): WorkflowRuntime => {
  const workflows = registerWorkflows();
  const context = bindWorkflowContext(dependencies);

  return {
    configure: () =>
      DBOS.setConfig({ name: APPLICATION_NAME, systemDatabaseUrl: dependencies.database.url }),
    launch: () => DBOS.launch(),
    shutdown: () => DBOS.shutdown(),
    dispose: () => context.dispose(),
    submit: async (runId, executionPlan, input) => {
      if ((await DBOS.getWorkflowStatus(runId)) !== null) {
        throw new Error('Run ID is already in use.');
      }
      await DBOS.startWorkflow(workflows.run, { workflowID: runId })(executionPlan, input);
      if (!matchesAdmission(await DBOS.getWorkflowStatus(runId), executionPlan, input)) {
        throw new Error('Run admission conflicts with existing workflow data.');
      }
    },
    get: async (runId) => {
      const status = await DBOS.getWorkflowStatus(runId);
      return status === null ? undefined : mapWorkflowStatus(status);
    },
  };
};
