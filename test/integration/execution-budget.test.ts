import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { RunExecutor, RunManager } from '../../src/index.js';
import {
  agentBinding,
  end,
  executionPlan,
  routeOutcomes,
  sequence,
  task,
} from '../dsl/pipeline-builder.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('execution budget', () => {
  it('rejects a sequential plan above its total execution bound before DBOS admission', async () => {
    const dispatched: string[] = [];
    const executor: RunExecutor = {
      execute: async ({ displayPath }) => {
        dispatched.push(displayPath);
        return { kind: 'completed', outcome: 'completed' };
      },
    };
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor,
    });
    await manager.start();

    const runId = `budget-${randomUUID()}`;
    await expect(
      manager.startRun({
        runId,
        executionPlan: executionPlan(sequence(task('first'), task('second'), end('succeeded')), {
          bindings: [agentBinding('first', 'worker'), agentBinding('second', 'worker')],
          policies: { maximumTotalNodeExecutions: 1 },
        }),
        input: null,
      }),
    ).rejects.toMatchObject({ code: 'execution_bound_exceeded' });

    expect(dispatched).toEqual([]);
    await expect(manager.getRun(runId)).resolves.toBeUndefined();
  });

  it('rejects a parallel plan above its total execution bound before child workflows start', async () => {
    const dispatched: string[] = [];
    const executor: RunExecutor = {
      execute: async ({ displayPath }) => {
        dispatched.push(displayPath);
        return { kind: 'completed', outcome: 'completed' };
      },
    };
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor,
    });
    await manager.start();

    const runId = `parallel-budget-${randomUUID()}`;
    await expect(
      manager.startRun({
        runId,
        executionPlan: executionPlan(
          routeOutcomes(
            {
              kind: 'parallel',
              key: 'work',
              branches: { first: task('first'), second: task('second') },
              join: {
                kind: 'all',
                successfulOutcomes: ['completed'],
                remaining: 'drain',
              },
            },
            { completed: end('succeeded'), failed: end('failed') },
          ),
          {
            bindings: [agentBinding('work/first', 'worker'), agentBinding('work/second', 'worker')],
            policies: { maximumTotalNodeExecutions: 1 },
          },
        ),
        input: null,
      }),
    ).rejects.toMatchObject({ code: 'execution_bound_exceeded' });

    expect(dispatched).toEqual([]);
    await expect(manager.getRun(runId)).resolves.toBeUndefined();
  });
});
