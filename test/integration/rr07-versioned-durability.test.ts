import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { describe, expect, it, vi } from 'vitest';

import { runWorkflowName, runWorkflowV2Name } from '../../src/dbos/dbos-names.js';
import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { loadAllWorkflowSteps } from '../../src/dbos/read-model/dbos-step-pages.js';
import { runWorkflowId, scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import type { RunExecutorResult } from '../../src/index.js';
import { createRootScopeId } from '../../src/pipeline/identity/execution-identity.js';
import {
  agentBinding,
  end,
  executionPlan,
  retryPolicy,
  routeOutcomes,
  sequence,
  task,
} from '../dsl/pipeline-builder.js';
import { RecoveryProcess } from '../support/process/recovery-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const workflows = new WorkflowRegistry();

describe('RR-07 versioned durability', () => {
  it('preserves the frozen v1 retry function history through shared composition', async () => {
    const runtime = new DbosRunRuntime(
      testDatabaseUrl(),
      {
        execute: async (request) =>
          request.attemptOrdinal === 1
            ? {
                kind: 'failed',
                error: { code: 'rate_limited', message: 'retryable' },
              }
            : { kind: 'completed', outcome: 'completed' },
      },
      workflows,
    );
    await runtime.start();
    const runId = `legacy-v1-retry-${randomUUID()}`;
    const plan = executionPlan(
      routeOutcomes(
        task('work', {
          retry: retryPolicy({
            maximumAttempts: 2,
            backoff: { kind: 'constant', delayMs: 10 },
          }),
        }),
        { completed: end('succeeded'), failed: end('failed') },
      ),
      { bindings: [agentBinding('work', 'developer')] },
    );

    try {
      const handle = await DBOS.startWorkflow(workflows.runV1, {
        workflowID: runWorkflowId(runId),
      })({ runId, admissionToken: 'A'.repeat(43), executionPlan: plan, input: null });
      await expect(handle.getResult()).resolves.toMatchObject({ status: 'succeeded' });

      const scopeId = createRootScopeId({ runId, rootPipelineId: plan.rootPipelineId });
      const functionNames = (await loadAllWorkflowSteps(scopeWorkflowId(scopeId))).map(
        ({ name }) => name,
      );
      expect(functionNames).toStrictEqual([
        'DBOS.send',
        'DBOS.recv',
        'DBOS.sleep',
        'DBOS.send',
        'node-effect-intent:1:main/work',
        'node-effect-decision:1:main/work',
        'DBOS.send',
        'DBOS.sleep',
        'DBOS.send',
        'DBOS.recv',
        'DBOS.sleep',
        'DBOS.send',
        'node-effect-intent:2:main/work',
        'node-effect-decision:2:main/work',
        'DBOS.send',
        'DBOS.send',
      ]);
    } finally {
      await runtime.stop();
    }
  }, 20_000);

  it('replays and reads a pre-cutover v1 run without sending it a command', async () => {
    let settleProvider: ((result: RunExecutorResult) => void) | undefined;
    const runtime = new DbosRunRuntime(
      testDatabaseUrl(),
      {
        execute: async () =>
          new Promise<RunExecutorResult>((resolve) => {
            settleProvider = resolve;
          }),
      },
      workflows,
    );
    await runtime.start();
    const runId = `legacy-v1-${randomUUID()}`;
    const plan = executionPlan(sequence(task('work'), end('succeeded')), {
      bindings: [agentBinding('work', 'developer')],
    });
    const durableInput = {
      runId,
      admissionToken: 'A'.repeat(43),
      executionPlan: plan,
      input: null,
    };

    try {
      const first = await DBOS.startWorkflow(workflows.runV1, {
        workflowID: runWorkflowId(runId),
      })(durableInput);
      await vi.waitFor(() => expect(settleProvider).toBeTypeOf('function'));
      const replay = await DBOS.startWorkflow(workflows.runV1, {
        workflowID: runWorkflowId(runId),
      })(durableInput);
      expect(replay.workflowID).toBe(first.workflowID);
      expect((await DBOS.getWorkflowStatus(runWorkflowId(runId)))?.workflowName).toBe(
        runWorkflowName,
      );

      await expect(runtime.cancelRun({ runId, actorId: 'operator' })).resolves.toMatchObject({
        status: 'rejected',
        reason: 'unsupported_run_version',
      });
      expect((await runtime.getRunEvents(runId, { limit: 100 })).items).toHaveLength(1);

      settleProvider?.({ kind: 'completed', outcome: 'completed' });
      await expect(first.getResult()).resolves.toEqual({
        status: 'succeeded',
        outcome: 'succeeded',
      });
      const snapshot = await runtime.getRun(runId);
      expect(snapshot).toMatchObject({ id: runId, status: 'succeeded' });
      await expect(runtime.getRunDetails(runId)).resolves.toMatchObject({ commands: [] });
    } finally {
      settleProvider?.({ kind: 'completed', outcome: 'cleanup' });
      await runtime.stop();
    }
  }, 20_000);

  it('recovers v2 partial history without replaying a checkpointed effect', async () => {
    const runId = `v2-partial-history-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId);
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/first' });
      firstProcess.complete('main/first');
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/second' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId);
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/second',
        attemptOrdinal: 2,
      });
      expect(recoveredProcess.dispatched('main/first')).toBe(0);
      recoveredProcess.complete('main/second');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'details' });
      expect(recoveredProcess.reportedDetails().workflowName).toBe(runWorkflowV2Name);
      await recoveredProcess.waitFor({ kind: 'events' });
      expect(recoveredProcess.eventStream().types).toStrictEqual([
        'nodeExecution.started',
        'nodeExecution.completed',
        'nodeExecution.started',
        'nodeExecution.failed',
        'nodeExecution.started',
        'nodeExecution.completed',
        'run.completed',
      ]);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);
});
