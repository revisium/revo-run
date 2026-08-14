import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parallelBranchWorkflowName, runExecutionWorkflowName } from '../../src/dbos/dbos-names.js';
import {
  EffectRecoveryProductRecords,
  type EffectRecoveryProductScope,
} from '../support/process/effect-recovery-product-records.js';
import { RecoveryProcess } from '../support/process/recovery-process.js';

const prepareAmbiguousEffect = async (
  process: RecoveryProcess,
  scope: EffectRecoveryProductScope,
): Promise<string> => {
  if (scope === 'root-execution') {
    await process.waitFor({ kind: 'dispatched', path: 'main/first' });
    process.complete('main/first');
    return 'main/second';
  }

  await process.waitFor({ kind: 'dispatched', path: 'main/work/a' });
  await process.waitFor({ kind: 'dispatched', path: 'main/work/b' });
  process.complete('main/work/a');
  await process.waitFor({ kind: 'checkpointed', path: 'main/work/a' });
  return 'main/work/b';
};

const operationIndex = (names: readonly string[], expected: string): number => {
  const index = names.indexOf(expected);
  expect(index, `Missing durable operation ${expected}.`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('product effect recovery across processes', () => {
  it.each(['root-execution', 'parallel-child'] as const)(
    'fences recovered execute in the registered %s workflow',
    async (scope) => {
      const runId = `effect-recovery-${scope}-${randomUUID()}`;
      const scenario = scope === 'root-execution' ? 'sequence' : 'parallel';
      const firstProcess = new RecoveryProcess('start', runId, scenario);
      const records = await EffectRecoveryProductRecords.connect();
      let recoveredProcess: RecoveryProcess | undefined;

      try {
        const path = await prepareAmbiguousEffect(firstProcess, scope);
        const firstDispatch = await firstProcess.waitFor({
          kind: 'dispatched',
          path,
          attemptOrdinal: 1,
        });
        await firstProcess.kill();

        recoveredProcess = new RecoveryProcess('recover', runId, scenario);
        const reconciliation = await recoveredProcess.waitFor({
          kind: 'reconciled',
          path,
          attemptOrdinal: 1,
        });
        expect(reconciliation.attemptId).toBe(firstDispatch.attemptId);
        expect(recoveredProcess.dispatched(path, 1)).toBe(0);

        await recoveredProcess.waitFor({ kind: 'dispatched', path, attemptOrdinal: 2 });
        recoveredProcess.complete(path);
        await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });

        const durable = await records.recoveryScope(runId, scope);
        expect(durable.workflowName).toBe(
          scope === 'root-execution' ? runExecutionWorkflowName : parallelBranchWorkflowName,
        );
        const names = durable.operations.map(({ name }) => name);
        const intentIndex = operationIndex(names, `node-effect-intent:1:${path}`);
        const decisionIndex = operationIndex(names, `node-effect-decision:1:${path}`);
        const reconcileIndex = operationIndex(names, `node-effect-reconcile:1:1:${path}`);
        expect(intentIndex).toBeLessThan(decisionIndex);
        expect(decisionIndex).toBeLessThan(reconcileIndex);

        const decision = durable.operations[decisionIndex]?.output;
        expect(decision).toMatchObject({
          kind: 'mustReconcile',
          request: { attemptId: firstDispatch.attemptId },
        });
        if (
          typeof decision !== 'object' ||
          decision === null ||
          !('liveRecoveryGeneration' in decision) ||
          !('storedRecoveryGeneration' in decision)
        ) {
          throw new Error('Recovered effect decision has no generation fence.');
        }
        expect(decision.liveRecoveryGeneration).toBeGreaterThan(
          Number(decision.storedRecoveryGeneration),
        );
        expect(durable.operations[reconcileIndex]?.output).toMatchObject({
          kind: 'runNodeReconciliation',
          request: { attemptId: firstDispatch.attemptId },
          reconciliationRound: 1,
          result: { kind: 'effectNotFound' },
        });
      } finally {
        try {
          await firstProcess.kill();
          await recoveredProcess?.kill();
        } finally {
          await records.close();
        }
      }
    },
    30_000,
  );

  it('restarts a crashed product reconciliation without repeating execute', async () => {
    const runId = `effect-reconcile-crash-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'sequence');
    let firstRecovery: RecoveryProcess | undefined;
    let secondRecovery: RecoveryProcess | undefined;

    try {
      const path = await prepareAmbiguousEffect(firstProcess, 'root-execution');
      const dispatch = await firstProcess.waitFor({
        kind: 'dispatched',
        path,
        attemptOrdinal: 1,
      });
      await firstProcess.kill();

      firstRecovery = new RecoveryProcess('recover', runId, 'sequence', undefined, {
        holdReconciliation: true,
      });
      const firstReconciliation = await firstRecovery.waitFor({
        kind: 'reconciled',
        path,
        attemptOrdinal: 1,
      });
      expect(firstReconciliation.attemptId).toBe(dispatch.attemptId);
      await firstRecovery.kill();

      secondRecovery = new RecoveryProcess('recover', runId, 'sequence');
      const secondReconciliation = await secondRecovery.waitFor({
        kind: 'reconciled',
        path,
        attemptOrdinal: 1,
      });
      expect(secondReconciliation.attemptId).toBe(dispatch.attemptId);
      expect(firstRecovery.dispatched(path, 1)).toBe(0);
      expect(secondRecovery.dispatched(path, 1)).toBe(0);

      await secondRecovery.waitFor({ kind: 'dispatched', path, attemptOrdinal: 2 });
      secondRecovery.complete(path);
      await secondRecovery.waitFor({ kind: 'terminal', status: 'succeeded' });
    } finally {
      await firstProcess.kill();
      await firstRecovery?.kill();
      await secondRecovery?.kill();
    }
  }, 30_000);
});
