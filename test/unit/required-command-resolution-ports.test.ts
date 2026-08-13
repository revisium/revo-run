import { describe, expect, it, vi } from 'vitest';

import type { RunExecutorRequest } from '../../src/contracts/executor/run-executor.js';
import { RunManager } from '../../src/manager/run-manager.js';
import type {
  ExecuteNodeEffect,
  WaitForRetry,
} from '../../src/pipeline/interpreter/interpreter-context.js';
import type { PipelineEventSink } from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import { PipelineInterpreter } from '../../src/pipeline/interpreter/pipeline-interpreter.js';
import { TaskNodeExecutor } from '../../src/pipeline/interpreter/task-node-executor.js';
import { rejectUnsupportedUnknownOutcomeResolution } from '../../src/pipeline/interpreter/unsupported-unknown-outcome-resolution.js';
import type { ParallelBranchRunner } from '../../src/pipeline/parallel/parallel-branch-runner.js';

const baseRuntime = {
  start: async () => undefined,
  stop: async () => undefined,
  startRun: async () => undefined,
  getRun: async () => undefined,
  listRuns: async () => ({ items: [] }),
  getRunDetails: async () => undefined,
  getRunEvents: async () => ({ items: [], hasMore: false }),
  subscribeRunEvents: async function* () {},
  waitForTerminal: async () => {
    throw new Error('not used');
  },
};

const executeEffect = vi.fn<ExecuteNodeEffect>(async () => ({ kind: 'cancelled' }));
const waitForRetry = vi.fn<WaitForRetry>(async () => undefined);
const branches = {
  supportsRemainingCancellation: false,
  execute: vi.fn<ParallelBranchRunner['execute']>(async () => []),
} satisfies ParallelBranchRunner;
const events = {
  write: vi.fn<PipelineEventSink['write']>(async () => undefined),
} satisfies PipelineEventSink;

describe('required command and unknown-resolution ports', () => {
  it('requires both command methods in every RunManager runtime composition', () => {
    // @ts-expect-error Both public command ports are required at composition time.
    const manager = new RunManager(baseRuntime);
    expect(manager).toBeDefined();
  });

  it('requires an explicit unknown-resolution strategy in both interpreter layers', () => {
    // @ts-expect-error PipelineInterpreter requires an explicit unknown-resolution port.
    const interpreter = new PipelineInterpreter(executeEffect, waitForRetry, branches, events);
    // @ts-expect-error TaskNodeExecutor requires an explicit unknown-resolution port.
    const taskExecutor = new TaskNodeExecutor(executeEffect, waitForRetry, events);
    expect([interpreter, taskExecutor]).toHaveLength(2);
  });

  it('fails closed if the named v1 unsupported strategy is ever reached', async () => {
    const request = {
      runId: 'run-1',
      scopeId: `sc1_${'a'.repeat(43)}`,
      authoredNodeId: `an1_${'b'.repeat(43)}`,
      nodeInstanceId: `ni1_${'c'.repeat(43)}`,
      attemptId: `at1_${'d'.repeat(43)}`,
      attemptOrdinal: 1,
      displayPath: 'main/work',
      pipelineId: 'main',
      nodePath: 'work',
      binding: {
        kind: 'agent' as const,
        target: { pipelineId: 'main', nodePath: 'work' },
        agentId: 'codex',
        roleId: 'worker',
        modelId: 'gpt-5.6',
      },
      input: {},
    } satisfies RunExecutorRequest;

    await expect(
      rejectUnsupportedUnknownOutcomeResolution(
        request,
        {
          reconciliation: 'required',
          maximumAttempts: 1,
          timeoutMs: 1_000,
          unknownOutcome: 'requireHumanResolution',
        },
        undefined,
        1,
      ),
    ).rejects.toThrow('V1 unknown-outcome resolution is unsupported.');
  });
});
