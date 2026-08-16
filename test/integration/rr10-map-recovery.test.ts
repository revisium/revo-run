import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { mapControlDecisionStepName } from '../../src/dbos/dbos-names.js';
import { countWorkflowStepsByName } from '../../src/dbos/read-model/dbos-step-pages.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { createRunManager } from '../../src/index.js';
import { createRootScopeId } from '../../src/pipeline/identity/execution-identity.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { RecoveryProcess } from '../support/process/recovery-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const countMapControlDecisions = async (runId: string): Promise<number> => {
  const inspector = createRunManager({
    database: { url: testDatabaseUrl() },
    executor: new ControlledRunExecutor(),
  });
  await inspector.start();
  try {
    const rootScopeId = createRootScopeId({ runId, rootPipelineId: 'main' });
    return await countWorkflowStepsByName(
      scopeWorkflowId(rootScopeId),
      mapControlDecisionStepName('main/repositories'),
    );
  } finally {
    await inspector.stop();
  }
};

describe.sequential('RR-10 map recovery', () => {
  it('replays settled items and resumes bounded pending work without duplicate effects', async () => {
    const runId = `map-recovery-${randomUUID()}`;
    const first = new RecoveryProcess('start', runId, 'map', undefined, {
      input: { repositories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      pauseBeforeAdmission: 2,
    });
    let recovered: RecoveryProcess | undefined;

    try {
      await first.waitFor({ kind: 'dispatched', path: 'main/repositories[a]/work' });
      await first.waitFor({ kind: 'beforeAdmission' });
      first.complete('main/repositories[a]/work');
      await first.waitFor({
        kind: 'attemptObserved',
        path: 'main/repositories[a]/work',
        status: 'completed',
      });
      await first.kill();

      recovered = new RecoveryProcess('recover', runId, 'map');
      await recovered.waitFor({
        kind: 'dispatched',
        path: 'main/repositories[b]/work',
        attemptOrdinal: 1,
      });
      expect(recovered.dispatched('main/repositories[a]/work')).toBe(0);
      recovered.complete('main/repositories[b]/work');
      await recovered.waitFor({ kind: 'dispatched', path: 'main/repositories[c]/work' });
      recovered.complete('main/repositories[c]/work');
      await recovered.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recovered.waitFor({ kind: 'stopped' });

      expect(recovered.dispatched('main/repositories[b]/work', 1)).toBe(1);
      expect(recovered.dispatched('main/repositories[c]/work')).toBe(1);
      await expect(countMapControlDecisions(runId)).resolves.toBe(1);
    } finally {
      await first.kill();
      await recovered?.kill();
    }
  }, 30_000);

  it('replays one persisted map control decision without redispatching settled effects', async () => {
    const runId = `map-decision-recovery-${randomUUID()}`;
    const first = new RecoveryProcess('start', runId, 'map', undefined, {
      input: { repositories: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      pauseAfterMapDecision: true,
    });
    let recovered: RecoveryProcess | undefined;

    try {
      await first.completeDispatchedWork([
        'main/repositories[a]/work',
        'main/repositories[b]/work',
        'main/repositories[c]/work',
      ]);
      await first.waitFor({ kind: 'afterDecision' });
      await first.kill();

      recovered = new RecoveryProcess('recover', runId, 'map');
      await recovered.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recovered.waitFor({ kind: 'stopped' });

      expect(recovered.dispatched('main/repositories[a]/work')).toBe(0);
      expect(recovered.dispatched('main/repositories[b]/work')).toBe(0);
      expect(recovered.dispatched('main/repositories[c]/work')).toBe(0);
      await expect(countMapControlDecisions(runId)).resolves.toBe(1);
    } finally {
      first.releaseDecision();
      await first.kill();
      await recovered?.kill();
    }
  }, 30_000);
});
