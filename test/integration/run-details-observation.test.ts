import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const startDetailsObservationManager = async () => {
  const executor = new ControlledRunExecutor();
  const started = createRunManager({ database: { url: testDatabaseUrl() }, executor });
  await started.start();
  return { executor, manager: started };
};

const nestedParallelPlan = () =>
  executionPlan(
    sequence(
      {
        kind: 'parallel',
        key: 'review',
        branches: {
          product: task('product'),
          assurance: {
            kind: 'parallel',
            key: 'assurance',
            branches: { security: task('security'), qa: task('qa') },
            join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
          },
        },
        join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
      },
      end('succeeded'),
    ),
    {
      bindings: [
        agentBinding('review/product', 'product'),
        agentBinding('review/assurance/security', 'security'),
        agentBinding('review/assurance/qa', 'qa'),
      ],
    },
  );

const completePagedRunSteps = (
  executor: ControlledRunExecutor,
  paths: readonly string[],
): Promise<void> =>
  paths.reduce<Promise<void>>(async (previous, path) => {
    await previous;
    await executor.expectStarted(path);
    await executor.complete(path, { kind: 'completed', outcome: 'completed' });
  }, Promise.resolve());

const startPagedRunObservationScenario = async () => {
  const { executor, manager: runManager } = await startDetailsObservationManager();
  const runId = `paged-details-${randomUUID()}`;
  const keys = Array.from({ length: 105 }, (_, index) => `work-${String(index).padStart(3, '0')}`);
  const paths = keys.map((key) => `main/${key}`);
  const plan = executionPlan(sequence(...keys.map((key) => task(key)), end('succeeded')), {
    bindings: keys.map((key) => agentBinding(key, 'worker')),
  });

  try {
    await runManager.startRun({ runId, executionPlan: plan, input: null });
    await completePagedRunSteps(executor, paths);
    await runManager.waitForTerminal(runId, { timeoutMs: 10_000 });
    return { manager: runManager, runId };
  } catch (error) {
    await runManager.stop();
    throw error;
  }
};

describe.sequential('real DBOS run details boundaries', () => {
  it('projects root and nested parallel child workflows with their completed attempts', async () => {
    const { executor, manager: runManager } = await startDetailsObservationManager();
    try {
      const runId = `nested-details-${randomUUID()}`;
      const paths = [
        'main/review/product',
        'main/review/assurance/security',
        'main/review/assurance/qa',
      ];
      await runManager.startRun({ runId, executionPlan: nestedParallelPlan(), input: null });
      await Promise.all(paths.map((path) => executor.expectStarted(path)));
      await Promise.all(
        paths.map((path) => executor.complete(path, { kind: 'completed', outcome: 'completed' })),
      );
      await expect(runManager.waitForTerminal(runId, { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: 'succeeded',
      });

      const details = await runManager.getRunDetails(runId);

      expect(details?.scopes.map(({ kind, displayPath }) => [kind, displayPath])).toEqual([
        ['root', 'main'],
        ['parallelBranch', 'main/review/product'],
        ['parallelBranch', 'main/review/assurance'],
        ['parallelBranch', 'main/review/assurance/security'],
        ['parallelBranch', 'main/review/assurance/qa'],
      ]);
      expect(details?.nodeInstances.map(({ displayPath }) => displayPath)).toEqual(paths);
      expect(details?.attempts.map(({ status }) => status)).toEqual([
        'completed',
        'completed',
        'completed',
      ]);
    } finally {
      await runManager.stop();
    }
  });

  describe('paged run observation scenario', () => {
    let scenario: Awaited<ReturnType<typeof startPagedRunObservationScenario>>;

    beforeAll(async () => {
      scenario = await startPagedRunObservationScenario();
    }, 20_000);

    afterAll(async () => {
      await scenario?.manager.stop();
    });

    it('loads all 105 durable node steps across the DBOS details boundary', async () => {
      const details = await scenario.manager.getRunDetails(scenario.runId);

      expect(details?.nodeInstances).toHaveLength(105);
      expect(details?.attempts).toHaveLength(105);
    });

    it('pages all 211 public events in 100, 100, and 11 event slices', async () => {
      const first = await scenario.manager.getRunEvents(scenario.runId, { limit: 100 });
      const second = await scenario.manager.getRunEvents(scenario.runId, {
        after: `${scenario.runId}:100`,
        limit: 100,
      });
      const final = await scenario.manager.getRunEvents(scenario.runId, {
        after: `${scenario.runId}:200`,
        limit: 100,
      });
      expect(first).toMatchObject({
        hasMore: true,
        nextCursor: `${scenario.runId}:100`,
      });
      expect(first.items).toHaveLength(100);
      expect(second).toMatchObject({
        hasMore: true,
        nextCursor: `${scenario.runId}:200`,
      });
      expect(second.items).toHaveLength(100);
      expect(final).toMatchObject({
        hasMore: false,
        nextCursor: `${scenario.runId}:211`,
      });
      expect(final.items).toHaveLength(11);
      expect([...first.items, ...second.items, ...final.items].map(({ cursor }) => cursor)).toEqual(
        Array.from({ length: 211 }, (_, index) => `${scenario.runId}:${index + 1}`),
      );
    });
  });
});
