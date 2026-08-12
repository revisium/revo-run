import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

import { DBOSClient } from '@dbos-inc/dbos-sdk';

import { testDatabaseUrl } from '../test-environment.js';

type PublicWorkflowStep = NonNullable<Awaited<ReturnType<DBOSClient['listWorkflowSteps']>>>[number];

export interface EffectRecoveryOperationRecord {
  readonly functionID: number;
  readonly name: string;
  readonly output: unknown;
}

export class EffectRecoverySpikeRecords {
  private constructor(private readonly client: DBOSClient) {}

  static async connect(): Promise<EffectRecoverySpikeRecords> {
    return new EffectRecoverySpikeRecords(
      await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl() }),
    );
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }

  async operations(workflowId: string): Promise<readonly EffectRecoveryOperationRecord[]> {
    const steps = await this.client.listWorkflowSteps(workflowId);
    assert(steps !== undefined, `Workflow ${workflowId} was not found.`);
    return steps.map(({ functionID, name, output }) => ({ functionID, name, output }));
  }

  async output(workflowId: string): Promise<unknown> {
    const workflow = await this.client.getWorkflow(workflowId);
    assert(workflow !== undefined, `Workflow ${workflowId} was not found.`);
    return workflow.output;
  }

  async waitForOperationCount(workflowId: string, count: number): Promise<void> {
    await this.pollForOperationCount(workflowId, count, Date.now() + 10_000);
  }

  private async pollForOperationCount(
    workflowId: string,
    count: number,
    deadline: number,
  ): Promise<void> {
    const operations = await this.operationsIfPresent(workflowId);
    if (operations !== undefined && operations.length === count) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Workflow ${workflowId} did not expose exactly ${count} public operation records.`,
      );
    }

    await wait(20);
    return this.pollForOperationCount(workflowId, count, deadline);
  }

  private async operationsIfPresent(
    workflowId: string,
  ): Promise<readonly PublicWorkflowStep[] | undefined> {
    return this.client.listWorkflowSteps(workflowId);
  }
}
