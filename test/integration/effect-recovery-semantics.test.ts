import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { EffectRecoverySpikeProcess } from '../support/process/effect-recovery-spike-process.js';
import type {
  EffectRecoverySpikePhase,
  EffectRecoverySpikeScenario,
  EffectRecoverySpikeScope,
} from '../support/process/effect-recovery-spike-protocol.js';
import { EffectRecoverySpikeRecords } from '../support/process/effect-recovery-spike-records.js';

interface SpikeIdentity {
  readonly attemptId: string;
  readonly semanticWorkflowId: string;
  readonly workflowId: string;
}

const runningProcesses = new Set<EffectRecoverySpikeProcess>();

const identity = (scope: EffectRecoverySpikeScope): SpikeIdentity => {
  const nonce = randomUUID();
  const semanticWorkflowId = `rr06-spike:${scope}:${nonce}`;
  return {
    attemptId: `rr06-attempt:${nonce}`,
    semanticWorkflowId,
    workflowId:
      scope === 'root-execution' ? semanticWorkflowId : `rr06-spike:parallel-parent:${nonce}`,
  };
};

const launch = (
  ids: SpikeIdentity,
  scope: EffectRecoverySpikeScope,
  scenario: EffectRecoverySpikeScenario,
  phase: EffectRecoverySpikePhase,
): EffectRecoverySpikeProcess => {
  const process = new EffectRecoverySpikeProcess({ ...ids, scope, scenario, phase });
  runningProcesses.add(process);
  return process;
};

const kill = async (process: EffectRecoverySpikeProcess): Promise<void> => {
  await process.kill();
  runningProcesses.delete(process);
};

afterEach(async () => {
  await Promise.all([...runningProcesses].map(async (process) => process.kill()));
  runningProcesses.clear();
});

describe('DBOS effect recovery semantic spike', () => {
  it.each(['root-execution', 'parallel-child'] as const)(
    'fences an ambiguous effect in the %s physical workflow',
    async (scope) => {
      const ids = identity(scope);
      const firstProcess = launch(ids, scope, 'crash-after-effect', 'start');

      const firstExecution = await firstProcess.waitFor({ kind: 'effectExecuted' });
      await kill(firstProcess);

      const recoveredProcess = launch(ids, scope, 'crash-after-effect', 'recover-complete');
      const generationFence = await recoveredProcess.waitFor({
        kind: 'intentCheckpointed',
      });
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'SUCCESS' });

      expect(firstExecution.liveGeneration).toBe(generationFence.storedGeneration);
      expect(generationFence.liveGeneration).toBeGreaterThan(
        generationFence.storedGeneration ?? Number.NaN,
      );
      expect(recoveredProcess.count('effectExecuted')).toBe(0);
      expect(recoveredProcess.count('reconcileStarted')).toBe(1);
    },
    30_000,
  );

  it('keeps ordinal one when the process dies before the intent checkpoint', async () => {
    const scope = 'root-execution';
    const ids = identity(scope);
    const firstProcess = launch(ids, scope, 'crash-before-intent', 'start');

    await firstProcess.waitFor({ kind: 'ready' });
    await kill(firstProcess);

    const recoveredProcess = launch(ids, scope, 'crash-before-intent', 'recover-complete');
    await recoveredProcess.waitFor({ kind: 'effectExecuted', attemptOrdinal: 1 });
    await recoveredProcess.waitFor({ kind: 'terminal', status: 'SUCCESS' });

    expect(recoveredProcess.count('effectExecuted')).toBe(1);
    expect(recoveredProcess.count('reconcileStarted')).toBe(0);
  }, 30_000);

  it('checkpoints intent, decision, and reconciliation as consecutive public operations', async () => {
    const scope = 'root-execution';
    const ids = identity(scope);
    const records = await EffectRecoverySpikeRecords.connect();
    const firstProcess = launch(ids, scope, 'crash-after-effect', 'start');

    try {
      await firstProcess.waitFor({ kind: 'effectExecuted' });
      await kill(firstProcess);

      const recoveredProcess = launch(ids, scope, 'crash-after-effect', 'recover-complete');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'SUCCESS' });
      const operations = await records.operations(ids.semanticWorkflowId);

      expect(operations.map(({ name }) => name)).toStrictEqual([
        'rr06-spike:intent:1',
        'rr06-spike:effect-decision:1',
        'rr06-spike:reconcile:1',
      ]);
      expect(operations.map(({ functionID }) => functionID)).toStrictEqual([0, 1, 2]);
      expect(operations[1]?.output).toMatchObject({ kind: 'mustReconcile' });
    } finally {
      await records.close();
    }
  }, 30_000);

  it('restarts a crashed reconciliation without repeating the effect', async () => {
    const scope = 'root-execution';
    const ids = identity(scope);
    const firstProcess = launch(ids, scope, 'reconcile-crash', 'start');

    await firstProcess.waitFor({ kind: 'effectExecuted' });
    await kill(firstProcess);

    const firstRecovery = launch(ids, scope, 'reconcile-crash', 'recover-hold-reconcile');
    await firstRecovery.waitFor({ kind: 'reconcileStarted' });
    await kill(firstRecovery);

    const secondRecovery = launch(ids, scope, 'reconcile-crash', 'recover-complete');
    await secondRecovery.waitFor({ kind: 'reconcileStarted' });
    await secondRecovery.waitFor({ kind: 'terminal', status: 'SUCCESS' });

    expect(firstRecovery.count('effectExecuted')).toBe(0);
    expect(secondRecovery.count('effectExecuted')).toBe(0);
  }, 30_000);

  it('allows overlapping timed-out observations without repeating the effect', async () => {
    const scope = 'root-execution';
    const ids = identity(scope);
    const firstProcess = launch(ids, scope, 'reconcile-timeout', 'start');

    await firstProcess.waitFor({ kind: 'effectExecuted' });
    await kill(firstProcess);

    const recoveredProcess = launch(ids, scope, 'reconcile-timeout', 'recover-timeout');
    await recoveredProcess.waitFor({ kind: 'reconcileTimedOut' });
    await recoveredProcess.waitFor({ kind: 'reconcileStarted', activeReconciliations: 2 });
    await recoveredProcess.waitFor({ kind: 'terminal', status: 'SUCCESS' });

    expect(recoveredProcess.count('reconcileStarted')).toBe(2);
    expect(recoveredProcess.count('effectExecuted')).toBe(0);
  }, 30_000);

  it('resumes one bounded durable wait without growing its operation history', async () => {
    const scope = 'root-execution';
    const ids = identity(scope);
    const records = await EffectRecoverySpikeRecords.connect();
    const firstProcess = launch(ids, scope, 'single-wait', 'start');

    try {
      await firstProcess.waitFor({ kind: 'waiting' });
      await records.waitForOperationCount(ids.semanticWorkflowId, 1);
      const beforeCrash = await records.operations(ids.semanticWorkflowId);
      await kill(firstProcess);

      const recoveredProcess = launch(ids, scope, 'single-wait', 'recover-complete');
      await recoveredProcess.waitFor({ kind: 'waiting' });
      const afterRecovery = await records.operations(ids.semanticWorkflowId);
      recoveredProcess.resolveWait();
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'SUCCESS' });
      const afterResolution = await records.operations(ids.semanticWorkflowId);

      expect(afterRecovery.map(({ functionID }) => functionID)).toStrictEqual(
        beforeCrash.map(({ functionID }) => functionID),
      );
      expect(afterResolution.map(({ functionID }) => functionID)).toStrictEqual([0, 1]);
      expect(afterResolution.map(({ name }) => name)).toStrictEqual(['DBOS.recv', 'DBOS.sleep']);
    } finally {
      await records.close();
    }
  }, 30_000);

  it('exposes outcome-unknown evidence through public DBOS records', async () => {
    const scope = 'root-execution';
    const ids = identity(scope);
    const records = await EffectRecoverySpikeRecords.connect();
    const firstProcess = launch(ids, scope, 'crash-after-effect', 'start');

    try {
      await firstProcess.waitFor({ kind: 'effectExecuted' });
      await kill(firstProcess);

      const recoveredProcess = launch(ids, scope, 'crash-after-effect', 'recover-complete');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'SUCCESS' });

      await expect(records.output(ids.semanticWorkflowId)).resolves.toStrictEqual({
        attemptId: ids.attemptId,
        kind: 'outcomeUnknown',
        recovery: { reconciliationRound: 1 },
      });
      const operations = await records.operations(ids.semanticWorkflowId);
      expect(operations.at(-1)?.output).toStrictEqual({
        attemptId: ids.attemptId,
        kind: 'outcomeUnknown',
        recovery: { reconciliationRound: 1 },
      });
    } finally {
      await records.close();
    }
  }, 30_000);
});
