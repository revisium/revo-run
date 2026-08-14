import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { runExecutionWorkflowName, runWorkflowName } from '../../src/dbos/dbos-names.js';
import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { runWorkflowId, scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import { createRootScopeId } from '../../src/pipeline/identity/execution-identity.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const workflows = new WorkflowRegistry();

describe('RR-08 single durable protocol', () => {
  it('runs, observes, and drains the canonical root and execution workflows', async () => {
    const runtime = new DbosRunRuntime(
      testDatabaseUrl(),
      { execute: async () => ({ kind: 'completed', outcome: 'completed' }) },
      workflows,
    );
    const runId = `rr08-canonical-${randomUUID()}`;
    const plan = executionPlan(sequence(task('work'), end('succeeded')), {
      bindings: [agentBinding('work', 'developer')],
    });

    await runtime.start();
    try {
      await runtime.startRun(runId, plan, null);
      await expect(
        runtime.waitForTerminal(runId, {}, new AbortController().signal),
      ).resolves.toMatchObject({ id: runId, status: 'succeeded' });
      await expect(DBOS.getWorkflowStatus(runWorkflowId(runId))).resolves.toMatchObject({
        workflowName: runWorkflowName,
      });
      const scopeId = createRootScopeId({ runId, rootPipelineId: plan.rootPipelineId });
      await expect(DBOS.getWorkflowStatus(scopeWorkflowId(scopeId))).resolves.toMatchObject({
        workflowName: runExecutionWorkflowName,
      });
      await expect(runtime.getRunDetails(runId)).resolves.toMatchObject({
        parallelJoins: [],
        skippedParallelBranches: [],
      });
    } finally {
      await runtime.stop();
    }
  }, 20_000);
});
