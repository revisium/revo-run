import { DBOS } from '@dbos-inc/dbos-sdk';

import type { CreateRunManagerOptions, RunSnapshot } from '../types.js';
import { registerWorkflows } from './register-workflows.js';
import { bindWorkflowContext } from './workflow-context.js';

const APPLICATION_NAME = 'revo-run';

export interface WorkflowRuntime {
  configure(): void;
  launch(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): void;
  submit(snapshot: RunSnapshot): Promise<RunAdmission>;
}

export interface RunAdmission {
  readonly acknowledgement: Promise<RunSnapshot>;
}

const ADMISSION_POLL_TIMEOUT_SECONDS = 5;
const ADMISSION_POLL_ATTEMPTS = 12;
const ADMISSION_WAIT_TIMEOUT_SECONDS = ADMISSION_POLL_TIMEOUT_SECONDS * ADMISSION_POLL_ATTEMPTS;

const waitForAdmission = async (runId: string): Promise<RunSnapshot> => {
  for (let attempt = 0; attempt < ADMISSION_POLL_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- admission polling is intentionally sequential
    const acknowledged = await DBOS.getEvent<RunSnapshot>(runId, 'created', {
      timeoutSeconds: ADMISSION_POLL_TIMEOUT_SECONDS,
    });
    if (acknowledged) {
      return acknowledged;
    }
  }
  throw new Error(
    `Timed out waiting ${String(ADMISSION_WAIT_TIMEOUT_SECONDS)} seconds for run ${runId} admission acknowledgement; the durable run remains submitted.`,
  );
};

export const createWorkflowRuntime = (dependencies: CreateRunManagerOptions): WorkflowRuntime => {
  const workflows = registerWorkflows();
  const context = bindWorkflowContext(dependencies);

  return {
    configure: () =>
      DBOS.setConfig({ name: APPLICATION_NAME, systemDatabaseUrl: dependencies.database.url }),
    launch: () => DBOS.launch(),
    shutdown: () => DBOS.shutdown(),
    dispose: () => context.dispose(),
    submit: async (snapshot) => {
      await DBOS.startWorkflow(workflows.run, { workflowID: snapshot.id })(snapshot);
      return { acknowledgement: waitForAdmission(snapshot.id) };
    },
  };
};
