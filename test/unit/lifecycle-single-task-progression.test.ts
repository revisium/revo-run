import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { describe, expect, it } from 'vitest';

import { createSingleTaskProgressionLifecycle } from '../../src/lifecycle/progression-construction.js';
import { digestCanonicalJson } from '../../src/policy/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';

const createPlan = () => {
  const compilation = compilePipeline(
    definePipeline({
      schemaVersion: 1,
      entry: 'work',
      facts: [],
      nodes: [
        {
          kind: 'task',
          key: 'work',
          outcomes: { completed: 'done', failed: 'done', cancelled: 'done', skipped: 'done' },
        },
        { kind: 'terminal', key: 'done', outcome: 'done' },
      ],
    }),
  );
  if (!compilation.ok) throw new Error('Test pipeline did not compile.');
  const executorBindings = [
    {
      configuration: {},
      configurationDigest: digestCanonicalJson({}),
      executor: { adapterId: 'test', revision: '1', digest: 'test' },
      idempotentExecution: true,
      nodeKey: 'work',
      retryPolicy: {
        backoffMultiplier: 1,
        initialBackoffMs: 0,
        maximumAttempts: 1,
        maximumBackoffMs: 0,
      },
      timeoutPolicy: {
        cancellationTimeoutMs: 100,
        executionTimeoutMs: 100,
        reconciliationTimeoutMs: 100,
      },
    },
  ];
  const terminalBindings = [{ nodeKey: 'done', outcome: 'done', status: 'succeeded' as const }];
  const pin = {
    id: 'single-task-plan',
    revision: '1',
    digest: digestCanonicalJson({
      id: 'single-task-plan',
      revision: '1',
      compiledPipeline: compilation.pipeline,
      executorBindings,
      terminalBindings,
    }),
  };
  return { compiledPipeline: compilation.pipeline, executorBindings, pin, terminalBindings };
};

describe('single-task lifecycle progression', () => {
  it('initializes exactly one task through the authoritative progression Store operation', async () => {
    const store = new LogicalRunStoreFake(2_000);
    const lifecycle = createSingleTaskProgressionLifecycle(store);
    const planDocument = createPlan();

    const created = await lifecycle.initializeSingleTaskRun({
      allocationSeed: 'allocation-1',
      idempotencyKey: 'start-1',
      input: { request: 1 },
      occurrenceKey: 'occurrence-1',
      planDocument,
      runId: 'run-1',
    });

    expect(created).toMatchObject({
      kind: 'committed',
      run: {
        id: 'run-1',
        progression: {
          nodes: [{ nodeKey: 'work', state: 'enabled' }],
          phase: 'active',
        },
        revision: 0,
        status: 'running',
      },
    });
    await expect(
      lifecycle.initializeSingleTaskRun({
        allocationSeed: 'ignored-on-replay',
        idempotencyKey: 'start-1',
        input: { request: 1 },
        occurrenceKey: 'ignored-on-replay',
        planDocument,
        runId: 'run-1',
      }),
    ).resolves.toMatchObject({ kind: 'replayed', run: { id: 'run-1' } });
  });

  it('fails closed for every topology outside one task and one terminal', async () => {
    const planDocument = createPlan();
    const unsupported = {
      ...planDocument,
      compiledPipeline: { ...planDocument.compiledPipeline, entry: 'done' },
    };
    const store = new LogicalRunStoreFake(2_000);
    const lifecycle = createSingleTaskProgressionLifecycle(store);

    await expect(
      lifecycle.initializeSingleTaskRun({
        allocationSeed: 'allocation-1',
        idempotencyKey: 'unsupported-1',
        input: null,
        occurrenceKey: 'occurrence-1',
        planDocument: unsupported,
        runId: 'run-unsupported',
      }),
    ).resolves.toMatchObject({ kind: 'fault', fault: { code: 'PLAN_INVALID' } });
  });
});
