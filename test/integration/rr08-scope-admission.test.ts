import { randomUUID } from 'node:crypto';

import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import { isActiveWorkflowStatus } from '../../src/dbos/workflow-status.js';
import { createRunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { RecoveryProcess } from '../support/process/recovery-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

describe('RR-08 scope admission fences', () => {
  it('keeps the root nonterminal until an abort-ignoring timed-out provider settles', async () => {
    const runId = `provider-idle-barrier-${randomUUID()}`;
    const process = new RecoveryProcess('start', runId, 'timeout', undefined, {
      ignoreAbort: true,
    });
    const client = await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl() });

    try {
      await process.waitFor({ kind: 'timeoutSignalled', path: 'main/work' });
      await process.waitFor({ kind: 'attemptObserved', path: 'main/work', status: 'timedOut' });
      expect(process.dispatched('main/after-timeout')).toBe(0);
      await expect(client.getWorkflow(runWorkflowId(runId))).resolves.toMatchObject({
        status: 'PENDING',
      });

      process.complete('main/work', { outcome: 'late-provider-settlement' });
      await process.waitFor({ kind: 'dispatched', path: 'main/after-timeout' });
      process.complete('main/after-timeout');
      await process.waitFor({ kind: 'terminal', status: 'succeeded' });
      await process.waitFor({ kind: 'stopped' });
    } finally {
      await process.kill();
      await client.destroy();
    }
  }, 30_000);

  it('starts a cancel-fenced child, consumes startCancelled before provider work, and settles it', async () => {
    const runId = `cancel-before-admission-${randomUUID()}`;
    const process = new RecoveryProcess('start', runId, 'parallel', undefined, {
      pauseBeforeAdmission: true,
    });
    const client = await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl() });

    try {
      await process.waitFor({ kind: 'beforeAdmission' });
      await process.waitFor({ kind: 'ready' });
      process.cancel('operator-before-admission');
      await expect(process.waitFor({ kind: 'commandReceipt' })).resolves.toMatchObject({
        commandReceipt: { status: 'accepted' },
      });
      process.releaseAdmission();

      await process.waitFor({ kind: 'terminal', status: 'cancelled' });
      expect(process.dispatched('main/work/a')).toBe(0);
      expect(process.dispatched('main/work/b')).toBe(0);
      const scopes = (
        await client.listWorkflows({
          workflowName: 'revo-run.parallel-branch',
          loadInput: true,
          limit: 100,
        })
      ).filter(({ input }) => {
        const durableInput = input?.[0];
        return (
          typeof durableInput === 'object' &&
          durableInput !== null &&
          'runId' in durableInput &&
          durableInput.runId === runId
        );
      });
      expect(scopes).not.toHaveLength(0);
      expect(scopes.every(({ status }) => !isActiveWorkflowStatus(status))).toBe(true);
      await process.waitFor({ kind: 'stopped' });
    } finally {
      process.releaseAdmission();
      await process.kill();
      await client.destroy();
    }
  }, 30_000);

  it('retains a join cancellation fence across an outstanding nested admission', async () => {
    const runId = `nested-admission-cancel-${randomUUID()}`;
    const process = new RecoveryProcess('start', runId, 'nested-cancel', undefined, {
      pauseBeforeAdmission: 3,
    });
    const client = await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl() });

    try {
      await process.waitFor({ kind: 'beforeAdmission' });
      await process.waitFor({ kind: 'dispatched', path: 'main/review/winner' });
      process.complete('main/review/winner');
      await process.waitFor({ kind: 'scopeCancellationAcknowledged' });
      process.releaseAdmission();

      await process.waitFor({ kind: 'terminal', status: 'succeeded' });
      expect(process.dispatched('main/review/inner/descendant')).toBe(0);
      const scopes = (
        await client.listWorkflows({
          workflowName: 'revo-run.parallel-branch',
          loadInput: true,
          limit: 100,
        })
      ).filter(({ input }) => {
        const durableInput = input?.[0];
        return (
          typeof durableInput === 'object' &&
          durableInput !== null &&
          'runId' in durableInput &&
          durableInput.runId === runId
        );
      });
      expect(scopes).toHaveLength(3);
      expect(scopes.every(({ status }) => !isActiveWorkflowStatus(status))).toBe(true);
      await process.waitFor({ kind: 'stopped' });
    } finally {
      process.releaseAdmission();
      await process.kill();
      await client.destroy();
    }
  }, 30_000);

  it('starts drain-only branches after a decision and settles them without provider calls', async () => {
    const executor = new ControlledRunExecutor();
    const manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    const runId = `settlement-only-drain-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'review',
          branches: { first: task('first'), second: task('second'), third: task('third') },
          join: { kind: 'any', successfulOutcomes: ['completed'], remaining: 'drain' },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('review/first', 'reviewer'),
          agentBinding('review/second', 'reviewer'),
          agentBinding('review/third', 'reviewer'),
        ],
        policies: { maximumActiveNodeExecutions: 1 },
      },
    );

    await manager.start();
    try {
      await manager.startRun({ runId, executionPlan: plan, input: null });
      await executor.expectStarted('main/review/first');
      await executor.complete('main/review/first', { kind: 'completed', outcome: 'completed' });
      await expect(manager.waitForTerminal(runId, { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: 'succeeded',
      });
      executor.expectNotDispatched('main/review/second');
      executor.expectNotDispatched('main/review/third');

      const details = await manager.getRunDetails(runId);
      expect(details?.parallelJoins).toEqual([
        expect.objectContaining({
          remaining: 'drain',
          observedBranchKeys: ['first'],
          outputEligibleBranchKeys: ['first'],
          skippedBranchKeys: [],
        }),
      ]);
      expect(
        details?.scopes.flatMap((scope) =>
          scope.kind === 'parallelBranch' ? [[scope.displayPath, scope.status]] : [],
        ),
      ).toEqual([
        ['main/review/first', 'succeeded'],
        ['main/review/second', 'cancelled'],
        ['main/review/third', 'cancelled'],
      ]);
    } finally {
      await manager.stop();
    }
  }, 15_000);

  it('reads a durable drain decision before later admissions and validates it after settlement', async () => {
    const runId = `transient-drain-read-${randomUUID()}`;
    const process = new RecoveryProcess('start', runId, 'drain-transient', undefined, {
      pauseAfterDecision: true,
    });

    try {
      await process.waitFor({ kind: 'dispatched', path: 'main/review/first' });
      process.complete('main/review/first');
      await process.waitFor({ kind: 'afterDecision' });
      await expect(process.waitFor({ kind: 'parallelObserved' })).resolves.toMatchObject({
        remaining: 'drain',
        observedBranchKeys: ['first'],
        skippedBranchKeys: [],
      });
      expect(process.dispatched('main/review/second')).toBe(0);
      expect(process.dispatched('main/review/third')).toBe(0);

      process.releaseDecision();
      await process.waitFor({ kind: 'terminal', status: 'succeeded' });
      await process.waitFor({ kind: 'stopped' });
    } finally {
      process.releaseDecision();
      await process.kill();
    }
  }, 30_000);

  it('recovers after the durable join decision without duplicating settled effects', async () => {
    const runId = `crash-after-decision-${randomUUID()}`;
    const first = new RecoveryProcess('start', runId, 'parallel', undefined, {
      pauseAfterDecision: true,
    });
    let recovered: RecoveryProcess | undefined;

    try {
      await first.waitFor({ kind: 'dispatched', path: 'main/work/a' });
      await first.waitFor({ kind: 'dispatched', path: 'main/work/b' });
      first.complete('main/work/a');
      first.complete('main/work/b');
      await first.waitFor({ kind: 'afterDecision' });
      await first.kill();

      recovered = new RecoveryProcess('recover', runId, 'parallel');
      await recovered.waitFor({ kind: 'terminal', status: 'succeeded' });
      expect(recovered.dispatched('main/work/a')).toBe(0);
      expect(recovered.dispatched('main/work/b')).toBe(0);
      await recovered.waitFor({ kind: 'stopped' });
    } finally {
      await first.kill();
      await recovered?.kill();
    }
  }, 30_000);

  it('keeps pending cancel branches never admitted and reports them as skipped in authored order', async () => {
    const executor = new ControlledRunExecutor();
    const manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    const runId = `never-admitted-skipped-${randomUUID()}`;
    const plan = executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'review',
          branches: { zebra: task('zebra'), alpha: task('alpha'), middle: task('middle') },
          join: { kind: 'any', successfulOutcomes: ['completed'], remaining: 'cancel' },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('review/zebra', 'reviewer'),
          agentBinding('review/alpha', 'reviewer'),
          agentBinding('review/middle', 'reviewer'),
        ],
        policies: { maximumActiveNodeExecutions: 1 },
      },
    );

    await manager.start();
    try {
      await manager.startRun({ runId, executionPlan: plan, input: null });
      await executor.expectStarted('main/review/zebra');
      await executor.complete('main/review/zebra', { kind: 'completed', outcome: 'completed' });
      await expect(manager.waitForTerminal(runId, { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: 'succeeded',
      });

      const details = await manager.getRunDetails(runId);
      expect(details?.parallelJoins).toEqual([
        expect.objectContaining({
          observedBranchKeys: ['zebra'],
          outputEligibleBranchKeys: ['zebra'],
          skippedBranchKeys: ['alpha', 'middle'],
        }),
      ]);
      expect(details?.skippedParallelBranches.map(({ branchKey }) => branchKey)).toEqual([
        'alpha',
        'middle',
      ]);
      expect(
        details?.scopes.flatMap((scope) =>
          scope.kind === 'parallelBranch' ? [scope.displayPath] : [],
        ),
      ).toEqual(['main/review/zebra']);
    } finally {
      await manager.stop();
    }
  }, 15_000);
});
