import { DBOS } from '@dbos-inc/dbos-sdk';
import type { JsonValue } from '@revisium/revo-pipeline';

import type { ExecutionPlan } from '../run/execution-plan.js';
import type { RunSnapshot } from '../run/run.js';
import type { RegisteredRunWorkflow } from './dbos-workflow-registry.js';
import { mapRunSnapshot } from './map-run-snapshot.js';

const applicationName = 'revo-run';
const runWorkflowName = 'revo-run.run.v1';

export class DbosRuntime {
  private readonly databaseUrl: string;
  private readonly runWorkflow: RegisteredRunWorkflow;

  constructor(databaseUrl: string, runWorkflow: RegisteredRunWorkflow) {
    this.databaseUrl = databaseUrl;
    this.runWorkflow = runWorkflow;
  }

  async start(): Promise<void> {
    DBOS.setConfig({
      name: applicationName,
      systemDatabaseUrl: this.databaseUrl,
    });
    await DBOS.launch();
  }

  async stop(): Promise<void> {
    await DBOS.shutdown();
  }

  async startRun(runId: string, executionPlan: ExecutionPlan, input: JsonValue): Promise<void> {
    if ((await DBOS.getWorkflowStatus(runId)) !== null) {
      throw new Error('Run ID is already in use.');
    }

    await DBOS.startWorkflow(this.runWorkflow, {
      duplicationPolicy: 'reject',
      workflowID: runId,
    })({ executionPlan, input });
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    const status = await DBOS.getWorkflowStatus(runId);
    return status === null ? undefined : mapRunSnapshot(status, runWorkflowName);
  }
}
