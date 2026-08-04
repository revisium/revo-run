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
  submit(snapshot: RunSnapshot): Promise<RunSnapshot>;
}

const waitForAdmission = async (runId: string): Promise<RunSnapshot> => {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- admission polling is intentionally sequential
    const acknowledged = await DBOS.getEvent<RunSnapshot>(runId, 'created', {
      timeoutSeconds: 60,
    });
    if (acknowledged) return acknowledged;
  }
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
      return waitForAdmission(snapshot.id);
    },
  };
};
