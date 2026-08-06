import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutor } from '../contracts/executor/run-executor.js';
import type { JsonValue } from '../contracts/json-value.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';
import type { RunDetails } from '../contracts/run/run-details.js';
import type { RunEvent } from '../contracts/run/run-event.js';
import type { RunSnapshot } from '../contracts/run/run.js';
import { parseRunEvent } from '../validation/run-event.validator.js';
import { runEventStreamName, runWorkflowName } from './dbos-names.js';
import { mapRunDetails } from './read-model/map-run-details.js';
import { mapRunSnapshot } from './read-model/map-run-snapshot.js';
import type { WorkflowRegistry } from './workflow-registry.js';

const applicationName = 'revo-run';

export class DbosRunRuntime {
  private readonly databaseUrl: string;
  private readonly executor: RunExecutor;
  private readonly workflows: WorkflowRegistry;
  private releaseExecutor: (() => void) | undefined;

  constructor(databaseUrl: string, executor: RunExecutor, workflows: WorkflowRegistry) {
    this.databaseUrl = databaseUrl;
    this.executor = executor;
    this.workflows = workflows;
  }

  async start(): Promise<void> {
    this.releaseExecutor = this.workflows.bindExecutor(this.executor);
    try {
      DBOS.setConfig({
        name: applicationName,
        systemDatabaseUrl: this.databaseUrl,
      });
      await DBOS.launch();
    } catch (error) {
      this.releaseExecutor();
      this.releaseExecutor = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await DBOS.shutdown();
    this.releaseExecutor?.();
    this.releaseExecutor = undefined;
  }

  async startRun(runId: string, executionPlan: ExecutionPlan, input: JsonValue): Promise<void> {
    if ((await DBOS.getWorkflowStatus(runId)) !== null) {
      throw new Error('Run ID is already in use.');
    }

    await DBOS.startWorkflow(this.workflows.run, {
      duplicationPolicy: 'reject',
      workflowID: runId,
    })({ executionPlan, input });
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    const status = await DBOS.getWorkflowStatus(runId);
    return status === null ? undefined : mapRunSnapshot(status, runWorkflowName);
  }

  async getRunDetails(runId: string): Promise<RunDetails | undefined> {
    const run = await this.getRun(runId);
    if (run === undefined) {
      return undefined;
    }

    const steps = await DBOS.listWorkflowSteps(runId);
    return mapRunDetails(run, steps ?? []);
  }

  async *subscribeRunEvents(runId: string): AsyncGenerator<RunEvent> {
    const run = await this.getRun(runId);
    if (run === undefined) {
      throw new Error('Run was not found.');
    }

    for await (const event of DBOS.readStream<unknown>(runId, runEventStreamName)) {
      yield parseRunEvent(event);
    }
  }
}
