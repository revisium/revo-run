import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { RecoveryProcess } from '../support/process/recovery-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

describe('process application version isolation', () => {
  it('recovers one child lineage without taking ownership of an active manager run', async () => {
    const ordinaryApplicationVersion = 'revo-run-vitest-v1';
    const executor = new ControlledRunExecutor();
    const manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    const ordinaryRunId = `ordinary-version-owner-${randomUUID()}`;
    const recoveryRunId = `isolated-version-recovery-${randomUUID()}`;
    let firstProcess: RecoveryProcess | undefined;
    let recoveredProcess: RecoveryProcess | undefined;
    let managerStarted = false;

    try {
      await manager.start();
      managerStarted = true;
      expect(DBOS.applicationVersion).toBe(ordinaryApplicationVersion);
      await manager.startRun({
        runId: ordinaryRunId,
        executionPlan: executionPlan(sequence(task('work'), end('succeeded')), {
          bindings: [agentBinding('work', 'worker')],
        }),
        input: null,
      });
      await executor.expectStarted('main/work');

      firstProcess = new RecoveryProcess('start', recoveryRunId);
      await firstProcess.waitFor({
        kind: 'ready',
        applicationVersion: firstProcess.applicationVersion,
      });
      expect(firstProcess.applicationVersion).not.toBe(ordinaryApplicationVersion);
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/first' });
      expect(firstProcess.dispatched('main/first')).toBe(1);
      expect(firstProcess.dispatched('main/work')).toBe(0);
      expect(executor.executionCount('main/first')).toBe(0);
      expect(executor.executionCount('main/second')).toBe(0);
      firstProcess.complete('main/first');
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/second' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', recoveryRunId);
      expect(recoveredProcess.applicationVersion).toBe(firstProcess.applicationVersion);
      expect(recoveredProcess.applicationVersion).not.toBe(ordinaryApplicationVersion);
      await recoveredProcess.waitFor({
        kind: 'ready',
        applicationVersion: firstProcess.applicationVersion,
      });
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/second',
        attemptOrdinal: 2,
      });
      expect(recoveredProcess.dispatched('main/first')).toBe(0);
      expect(recoveredProcess.dispatched('main/work')).toBe(0);
      recoveredProcess.complete('main/second');
      await expect(
        recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' }),
      ).resolves.toMatchObject({ status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'stopped' });

      expect(firstProcess.dispatched('main/work')).toBe(0);
      expect(recoveredProcess.dispatched('main/work')).toBe(0);
      expect(executor.executionCount('main/first')).toBe(0);
      expect(executor.executionCount('main/second')).toBe(0);
      expect(executor.executionCount('main/work')).toBe(1);
      await expect(manager.getRun(ordinaryRunId)).resolves.toMatchObject({ status: 'running' });
      await executor.complete('main/work', { kind: 'completed', outcome: 'completed' });
      await expect(
        manager.waitForTerminal(ordinaryRunId, { timeoutMs: 5_000 }),
      ).resolves.toMatchObject({ status: 'succeeded' });
      expect(executor.executionCount('main/work')).toBe(1);
    } finally {
      await firstProcess?.kill();
      await recoveredProcess?.kill();
      if (managerStarted) {
        await manager.stop();
      }
    }
  }, 30_000);
});
