import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

import { DBOSClient } from '@dbos-inc/dbos-sdk';

import {
  isRetryBackoffStepName,
  runExecutionWorkflowV2Name,
} from '../../../src/dbos/dbos-names.js';
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
  readonly output: unknown;
}

const isPositiveDurationSleep = (step: WorkflowStep): boolean =>
  step.name === 'DBOS.sleep' &&
  step.startedAtEpochMs !== undefined &&
  typeof step.output === 'number' &&
  step.output > step.startedAtEpochMs + 1_000;

const isRetryBackoffCheckpoint = (
  value: unknown,
): value is { readonly attemptId: string; readonly delayMs: number } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'attemptId' in value &&
  typeof value.attemptId === 'string' &&
  'delayMs' in value &&
  typeof value.delayMs === 'number' &&
  Number.isSafeInteger(value.delayMs) &&
  value.delayMs >= 0;

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
    const sleeps = this.retryBackoffSleeps(steps);
    assert(sleeps.length <= 1, 'Retry loop recorded more than one associated backoff sleep.');
    const sleep = sleeps[0];
    return sleep === undefined ? undefined : this.retrySleepRecord(workflowId, sleep);
  }

  async operationsForRun(runId: string): Promise<readonly WorkflowOperationRecord[]> {
    const workflowId = await this.owningWorkflowId(runId);
    assert(workflowId !== undefined, `Run ${runId} has no owning scope workflow.`);
    return (await this.workflowSteps(workflowId)).map(
      ({ functionID, name, childWorkflowID, startedAtEpochMs, completedAtEpochMs, output }) => ({
        functionID,
        name,
        childWorkflowID,
        output,
        ...(startedAtEpochMs === undefined ? {} : { startedAtEpochMs }),
        ...(completedAtEpochMs === undefined ? {} : { completedAtEpochMs }),
      }),
    );
  }

  async retryBackoffSleepsForRun(runId: string): Promise<readonly RetrySleepRecord[]> {
    const workflowId = await this.owningWorkflowId(runId);
    assert(workflowId !== undefined, `Run ${runId} has no owning scope workflow.`);
    return this.retryBackoffSleeps(await this.workflowSteps(workflowId)).map((sleep) =>
      this.retrySleepRecord(workflowId, sleep),
    );
  }

  private async owningWorkflowId(runId: string): Promise<string | undefined> {
    const workflows = await this.client.listWorkflows({
      parentWorkflowID: runWorkflowId(runId),
      workflowName: runExecutionWorkflowV2Name,
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
    assert(typeof sleep.output === 'number', 'Durable retry sleep has no deadline.');
    assert(
      sleep.output > sleep.startedAtEpochMs,
      'Durable retry sleep must have a positive duration.',
    );
    return {
      workflowId,
      functionID: sleep.functionID,
      startedAtEpochMs: sleep.startedAtEpochMs,
      deadlineEpochMs: sleep.output,
    };
  }

  private retryBackoffSleeps(steps: readonly WorkflowStep[]): readonly WorkflowStep[] {
    return steps.flatMap((checkpoint, index) => {
      if (!isRetryBackoffStepName(checkpoint.name)) {
        return [];
      }
      const output = checkpoint.output;
      assert(isRetryBackoffCheckpoint(output), 'Retry backoff checkpoint output is invalid.');
      const { attemptId, delayMs } = output;
      assert(checkpoint.name.endsWith(attemptId), 'Retry backoff checkpoint attempt is invalid.');
      const nextCheckpoint = steps.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && isRetryBackoffStepName(candidate.name),
      );
      const boundary = nextCheckpoint < 0 ? steps.length : nextCheckpoint;
      const associated = steps
        .slice(index + 1, boundary)
        .filter(
          (candidate) =>
            isPositiveDurationSleep(candidate) &&
            candidate.startedAtEpochMs !== undefined &&
            candidate.output === candidate.startedAtEpochMs + delayMs,
        );
      assert(associated.length <= 1, 'Retry checkpoint has multiple associated backoff sleeps.');
      return associated;
    });
  }
}
