import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

import { DBOSClient } from '@dbos-inc/dbos-sdk';

import { runExecutionWorkflowName } from '../../../src/dbos/dbos-names.js';
import { runWorkflowId } from '../../../src/dbos/workflow-id.js';
import { testDatabaseUrl } from '../test-environment.js';

type WorkflowStep = NonNullable<Awaited<ReturnType<DBOSClient['listWorkflowSteps']>>>[number];

export interface RetrySleepRecord {
  readonly workflowId: string;
  readonly functionID: number;
  readonly startedAtEpochMs: number;
  readonly deadlineEpochMs: number;
}

export interface WorkflowOperationRecord {
  readonly functionID: number;
  readonly name: string;
  readonly childWorkflowID: string | null;
  readonly startedAtEpochMs?: number;
  readonly completedAtEpochMs?: number;
}

const isPositiveDurationSleep = (step: WorkflowStep): boolean =>
  step.name === 'DBOS.sleep' &&
  step.startedAtEpochMs !== undefined &&
  step.completedAtEpochMs !== undefined &&
  step.completedAtEpochMs > step.startedAtEpochMs &&
  step.output === step.completedAtEpochMs;

export class RetryBackoffRecords {
  private constructor(private readonly client: DBOSClient) {}

  static async connect(): Promise<RetryBackoffRecords> {
    return new RetryBackoffRecords(
      await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl() }),
    );
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }

  async waitForPositiveDurationSleep(runId: string): Promise<RetrySleepRecord> {
    return this.pollForPositiveDurationSleep(runId, Date.now() + 5_000);
  }

  async positiveDurationSleepForRun(runId: string): Promise<RetrySleepRecord | undefined> {
    const workflowId = await this.owningWorkflowId(runId);
    if (workflowId === undefined) {
      return undefined;
    }
    const steps = await this.workflowSteps(workflowId);
    const sleeps = steps.filter(isPositiveDurationSleep);
    assert(sleeps.length <= 1, 'Retry loop recorded more than one positive-duration sleep.');
    const sleep = sleeps[0];
    return sleep === undefined ? undefined : this.retrySleepRecord(workflowId, sleep);
  }

  async operationsForRun(runId: string): Promise<readonly WorkflowOperationRecord[]> {
    const workflowId = await this.owningWorkflowId(runId);
    assert(workflowId !== undefined, `Run ${runId} has no owning scope workflow.`);
    return (await this.workflowSteps(workflowId)).map(
      ({ functionID, name, childWorkflowID, startedAtEpochMs, completedAtEpochMs }) => ({
        functionID,
        name,
        childWorkflowID,
        ...(startedAtEpochMs === undefined ? {} : { startedAtEpochMs }),
        ...(completedAtEpochMs === undefined ? {} : { completedAtEpochMs }),
      }),
    );
  }

  private async owningWorkflowId(runId: string): Promise<string | undefined> {
    const workflows = await this.client.listWorkflows({
      parentWorkflowID: runWorkflowId(runId),
      workflowName: runExecutionWorkflowName,
      limit: 2,
    });
    assert(workflows.length <= 1, `Run ${runId} has multiple owning scope workflows.`);
    return workflows[0]?.workflowID;
  }

  private async workflowSteps(workflowId: string): Promise<readonly WorkflowStep[]> {
    const steps = await this.client.listWorkflowSteps(workflowId);
    assert(steps !== undefined, `Workflow ${workflowId} was not found.`);
    return steps;
  }

  private async pollForPositiveDurationSleep(
    runId: string,
    timeoutAt: number,
  ): Promise<RetrySleepRecord> {
    const sleep = await this.positiveDurationSleepForRun(runId);
    if (sleep !== undefined) {
      return sleep;
    }
    if (Date.now() >= timeoutAt) {
      throw new Error(`Run ${runId} did not record its durable retry sleep.`);
    }

    await wait(20);
    return this.pollForPositiveDurationSleep(runId, timeoutAt);
  }

  private retrySleepRecord(workflowId: string, sleep: WorkflowStep): RetrySleepRecord {
    assert(sleep.startedAtEpochMs !== undefined, 'Durable retry sleep has no start time.');
    assert(sleep.completedAtEpochMs !== undefined, 'Durable retry sleep has no deadline.');
    assert.equal(sleep.output, sleep.completedAtEpochMs, 'Durable retry sleep deadlines disagree.');
    assert(
      sleep.completedAtEpochMs > sleep.startedAtEpochMs,
      'Durable retry sleep must have a positive duration.',
    );
    return {
      workflowId,
      functionID: sleep.functionID,
      startedAtEpochMs: sleep.startedAtEpochMs,
      deadlineEpochMs: sleep.completedAtEpochMs,
    };
  }
}
