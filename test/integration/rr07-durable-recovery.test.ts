import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { runWorkflowName } from '../../src/dbos/dbos-names.js';
import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import type { RunExecutorResult } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { RecoveryProcess } from '../support/process/recovery-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const workflows = new WorkflowRegistry();

describe('RR-07 durable recovery on the canonical protocol', () => {
  it('recovers partial history without replaying a checkpointed effect', async () => {
    const runId = `partial-history-${randomUUID()}`;
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
      expect(recoveredProcess.reportedDetails().workflowName).toBe(runWorkflowName);
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

  it('replays canonical cancellation without redispatching the provider effect', async () => {
    let dispatches = 0;
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const runtime = new DbosRunRuntime(
      testDatabaseUrl(),
      {
        execute: async (_request, context) => {
          dispatches += 1;
          providerStarted?.();
          return new Promise<RunExecutorResult>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
      },
      workflows,
    );
    const runId = `canonical-cancel-${randomUUID()}`;
    const plan = executionPlan(sequence(task('work'), end('succeeded')), {
      bindings: [agentBinding('work', 'developer')],
    });
    const durableInput = {
      runId,
      admissionToken: 'A'.repeat(43),
      executionPlan: plan,
      input: null,
    };

    await runtime.start();
    try {
      const first = await DBOS.startWorkflow(workflows.run, {
        workflowID: runWorkflowId(runId),
      })(durableInput);
      await started;
      await expect(runtime.cancelRun({ runId, actorId: 'operator' })).resolves.toMatchObject({
        status: 'accepted',
      });
      await expect(first.getResult()).resolves.toEqual({
        status: 'cancelled',
        outcome: 'cancelled',
      });

      const replay = await DBOS.startWorkflow(workflows.run, {
        workflowID: runWorkflowId(runId),
      })(durableInput);
      await expect(replay.getResult()).resolves.toEqual({
        status: 'cancelled',
        outcome: 'cancelled',
      });
      expect(dispatches).toBe(1);
      expect(
        (await runtime.getRunEvents(runId, { limit: 100 })).items.map(({ type }) => type),
      ).toEqual(['nodeExecution.started', 'runCommand.accepted']);
      await expect(runtime.getRunDetails(runId)).resolves.toMatchObject({
        attempts: [expect.objectContaining({ status: 'cancelled' })],
        nodeInstances: [expect.objectContaining({ status: 'cancelled' })],
      });
    } finally {
      await runtime.stop();
    }
  }, 20_000);
});
