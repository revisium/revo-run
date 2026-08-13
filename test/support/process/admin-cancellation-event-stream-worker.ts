import assert from 'node:assert/strict';

import { DBOS } from '@dbos-inc/dbos-sdk';

import { scopeWorkflowV2Id, runWorkflowId } from '../../../src/dbos/workflow-id.js';
import { createRunManager } from '../../../src/index.js';
import type { RunEvent } from '../../../src/index.js';
import { createRootScopeId } from '../../../src/pipeline/identity/execution-identity.js';
import { agentBinding, executionPlan, task } from '../../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../executor/controlled-run-executor.js';
import type { AdminCancellationEventStreamReport } from './admin-cancellation-event-stream-process.js';

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const send = (message: object): void => {
  process.send?.(message);
};

const waitForCancelledWorkflow = async (
  workflowId: string,
  deadline = Date.now() + 5_000,
): Promise<string> => {
  const status = await DBOS.getWorkflowStatus(workflowId);
  if (status?.status === 'CANCELLED') {
    return status.status;
  }
  if (Date.now() >= deadline) {
    throw new Error(`Workflow ${workflowId} did not become cancelled.`);
  }

  await new Promise((resolve) => setTimeout(resolve, 20));
  return waitForCancelledWorkflow(workflowId, deadline);
};

const acceptedPrefixAfterCancellation = async (
  subscription: AsyncIterator<RunEvent>,
  first: IteratorResult<RunEvent>,
): Promise<readonly RunEvent[]> => {
  const next = await subscription.next();
  if (!next.done) {
    throw new Error('Administrative cancellation published an unexpected event.');
  }
  if (first.done) {
    throw new Error('Administrative cancellation stream ended before its accepted prefix.');
  }

  return [first.value];
};

const run = async (): Promise<void> => {
  const runId = requiredEnvironment('REVO_RUN_TEST_RUN_ID');
  const executor = new ControlledRunExecutor();
  const manager = createRunManager({
    database: { url: requiredEnvironment('REVO_RUN_TEST_DATABASE_URL') },
    executor,
  });
  await manager.start();
  await manager.startRun({
    runId,
    executionPlan: executionPlan(task('work'), {
      bindings: [agentBinding('work', 'worker')],
    }),
    input: null,
  });

  const subscription = manager.subscribeRunEvents(runId)[Symbol.asyncIterator]();
  const first = await subscription.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, 'nodeExecution.started');

  await DBOS.cancelWorkflow(runWorkflowId(runId), { cancelChildren: true });
  const childStatus = await waitForCancelledWorkflow(
    scopeWorkflowV2Id(createRootScopeId({ runId, rootPipelineId: 'main' })),
  );
  const runSnapshot = await manager.waitForTerminal(runId, { timeoutMs: 1_000 });
  const acceptedPrefix = await acceptedPrefixAfterCancellation(subscription, first);
  const eventPage = await manager.getRunEvents(runId);
  executor.expectNoExternalEffect('main/work');

  const report: AdminCancellationEventStreamReport = {
    acceptedPrefix,
    childStatus,
    eventPage,
    noExternalEffect: true,
    run: runSnapshot,
  };
  send({ kind: 'report', ...report });
};

void run().catch((error: unknown) => {
  send({ kind: 'error', message: error instanceof Error ? error.stack : String(error) });
});
