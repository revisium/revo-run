import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

import { scenarioRealTimeMs } from '../../dsl/scenario-time.js';
import type { RunScenario } from '../../dsl/scenario.js';
import { RecoveryProcess } from './recovery-process.js';

export const runRetryRecoveryScenario = async (scenario: RunScenario): Promise<void> => {
  assert.equal(scenario.intentId, 'rr-010');
  const crashIndex = scenario.steps.findIndex(({ kind }) => kind === 'crashManager');
  assert(crashIndex >= 0, 'Retry recovery scenario is missing its crash step.');
  const beforeCrashMs = scenarioRealTimeMs(scenario.steps.slice(0, crashIndex));
  const retryDelayMs = scenarioRealTimeMs(scenario.steps);
  assert(beforeCrashMs > 0 && retryDelayMs > beforeCrashMs);

  const firstProcess = new RecoveryProcess('start', scenario.intentId, 'retry', retryDelayMs);
  let recoveredProcess: RecoveryProcess | undefined;

  try {
    await firstProcess.waitFor({
      kind: 'dispatched',
      path: 'main/work',
      attemptOrdinal: 1,
    });
    await firstProcess.waitFor({ kind: 'checkpointed', path: 'main/work' });
    await wait(beforeCrashMs);
    await firstProcess.kill();

    recoveredProcess = new RecoveryProcess('recover', scenario.intentId, 'retry', retryDelayMs);
    await recoveredProcess.waitFor({
      kind: 'dispatched',
      path: 'main/work',
      attemptOrdinal: 2,
    });
    assert.equal(firstProcess.dispatched('main/work', 1), 1);
    assert.equal(recoveredProcess.dispatched('main/work', 1), 0);
    assert.equal(recoveredProcess.dispatched('main/work', 2), 1);

    recoveredProcess.complete('main/work');
    await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
    await recoveredProcess.waitFor({ kind: 'events' });
    const events = recoveredProcess.eventStream();
    assert.deepEqual(events.types, [
      'nodeExecution.started',
      'nodeExecution.failed',
      'nodeExecution.started',
      'nodeExecution.completed',
      'run.completed',
    ]);
    assert.deepEqual(
      events.cursors,
      events.cursors.map((_, index) => `${scenario.intentId}:${index + 1}`),
    );
    await recoveredProcess.waitFor({ kind: 'stopped' });
  } finally {
    await firstProcess.kill();
    await recoveredProcess?.kill();
  }
};
