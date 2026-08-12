import assert from 'node:assert/strict';

import { DBOSClient } from '@dbos-inc/dbos-sdk';

import {
  parallelBranchWorkflowName,
  runExecutionWorkflowName,
} from '../../../src/dbos/dbos-names.js';
import { runWorkflowId } from '../../../src/dbos/workflow-id.js';
import { testDatabaseUrl } from '../test-environment.js';

export type EffectRecoveryProductScope = 'parallel-child' | 'root-execution';

export interface ProductRecoveryOperation {
  readonly functionID: number;
  readonly name: string;
  readonly output: unknown;
}

export interface ProductRecoveryScopeRecords {
  readonly operations: readonly ProductRecoveryOperation[];
  readonly workflowName: string;
}

export class EffectRecoveryProductRecords {
  private constructor(private readonly client: DBOSClient) {}

  static async connect(): Promise<EffectRecoveryProductRecords> {
    return new EffectRecoveryProductRecords(
      await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl() }),
    );
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }

  async recoveryScope(
    runId: string,
    scope: EffectRecoveryProductScope,
  ): Promise<ProductRecoveryScopeRecords> {
    const rootWorkflowId = await this.rootExecutionWorkflowId(runId);
    const workflow =
      scope === 'root-execution'
        ? { workflowID: rootWorkflowId, workflowName: runExecutionWorkflowName }
        : await this.recoveredParallelWorkflow(rootWorkflowId);
    const steps = await this.client.listWorkflowSteps(workflow.workflowID);
    assert(steps !== undefined, `Workflow ${workflow.workflowID} was not found.`);
    return {
      workflowName: workflow.workflowName,
      operations: steps.map(({ functionID, name, output }) => ({ functionID, name, output })),
    };
  }

  private async rootExecutionWorkflowId(runId: string): Promise<string> {
    const workflows = await this.client.listWorkflows({
      parentWorkflowID: runWorkflowId(runId),
      workflowName: runExecutionWorkflowName,
      limit: 2,
    });
    assert.equal(workflows.length, 1, `Run ${runId} must have one root execution workflow.`);
    const workflow = workflows[0];
    assert(workflow !== undefined);
    return workflow.workflowID;
  }

  private async recoveredParallelWorkflow(
    rootWorkflowId: string,
  ): Promise<{ readonly workflowID: string; readonly workflowName: string }> {
    const workflows = await this.client.listWorkflows({
      parentWorkflowID: rootWorkflowId,
      workflowName: parallelBranchWorkflowName,
      limit: 10,
    });
    const inspected = await Promise.all(
      workflows.map(async (workflow) => ({
        workflow,
        steps: await this.client.listWorkflowSteps(workflow.workflowID),
      })),
    );
    const candidates = inspected
      .filter(({ steps }) => steps?.some(({ name }) => name.startsWith('node-effect-reconcile:')))
      .map(({ workflow }) => workflow);
    assert.equal(candidates.length, 1, 'Run must have one reconciled parallel branch workflow.');
    const workflow = candidates[0];
    assert(workflow !== undefined);
    return { workflowID: workflow.workflowID, workflowName: workflow.workflowName };
  }
}
