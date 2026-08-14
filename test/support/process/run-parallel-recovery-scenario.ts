import { randomUUID } from 'node:crypto';

import type { RunScenario } from '../../dsl/scenario.js';
import { RecoveryProcess } from './recovery-process.js';

export const runParallelRecoveryScenario = async (scenario: RunScenario): Promise<void> => {
  if (scenario.intentId !== 'rr-078') {
    throw new Error('Parallel recovery harness received an unsupported scenario.');
  }
  const runId = `acceptance-${randomUUID()}`;
  const firstProcess = new RecoveryProcess('start', runId, 'parallel');
  let recoveredProcess: RecoveryProcess | undefined;

  try {
    await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/a' });
    await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/b' });
    firstProcess.complete('main/work/a');
    await firstProcess.waitFor({ kind: 'checkpointed', path: 'main/work/a' });
    await firstProcess.kill();

    recoveredProcess = new RecoveryProcess('recover', runId, 'parallel');
    const reconciliation = await recoveredProcess.waitFor({
      kind: 'reconciled',
      path: 'main/work/b',
      attemptOrdinal: 1,
    });
    if (reconciliation.attemptId === undefined) {
      throw new Error('Recovery did not reconcile the interrupted parallel effect.');
    }
    await recoveredProcess.waitFor({
      kind: 'dispatched',
      path: 'main/work/b',
      attemptOrdinal: 2,
    });
    if (recoveredProcess.dispatched('main/work/a') !== 0) {
      throw new Error('Recovery duplicated a checkpointed parallel effect.');
    }
    recoveredProcess.complete('main/work/b');
    await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
    await recoveredProcess.waitFor({ kind: 'stopped' });
  } finally {
    await firstProcess.kill();
    await recoveredProcess?.kill();
  }
};
