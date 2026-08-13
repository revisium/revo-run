import { describe, expect, it } from 'vitest';

import type { RunExecutorResult } from '../../src/contracts/executor/run-executor.js';
import type { TaskNode } from '../../src/contracts/pipeline/pipeline-node.js';
import { createAttemptId } from '../../src/pipeline/identity/execution-identity.js';
import type {
  ExecuteNodeEffect,
  PipelineExecutionContext,
  WaitForRetry,
  WaitForUnknownOutcome,
} from '../../src/pipeline/interpreter/interpreter-context.js';
import type {
  PipelineEventDraft,
  PipelineEventSink,
} from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import { TaskNodeExecutor } from '../../src/pipeline/interpreter/task-node-executor.js';
import { taskExecutionPlan } from '../support/execution-plan.fixture.js';

type AttemptResponse =
  | RunExecutorResult
  | Exclude<Awaited<ReturnType<ExecuteNodeEffect>>, { readonly kind: 'effectResult' }>;

class RecordingAttemptRuntime {
  readonly delays: number[] = [];
  readonly events: PipelineEventDraft[] = [];
  readonly requests: Parameters<ExecuteNodeEffect>[0][] = [];
  private readonly responses: AttemptResponse[];

  constructor(responses: readonly AttemptResponse[]) {
    this.responses = [...responses];
  }

  readonly execute: ExecuteNodeEffect = async (request) => {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error('No recorded attempt response remains.');
    }
    switch (response.kind) {
      case 'effectNotFound':
      case 'cancelled':
      case 'executionLimitExceeded':
      case 'outcomeUnknown':
      case 'recoveryExhausted':
      case 'timedOut':
        return response;
      case 'completed':
      case 'failed':
      case 'inputResolutionFailed':
        return {
          kind: 'effectResult',
          execution: { kind: 'runNodeExecution', request, result: response },
          nextReconciliationRound: 1,
        };
    }
    throw new Error('Recorded attempt response is unsupported.');
  };

  readonly wait: WaitForRetry = async (_request, delayMs) => {
    this.delays.push(delayMs);
  };

  readonly write: PipelineEventSink['write'] = async (event) => {
    this.events.push(event);
  };
}

const executionContext = (node: TaskNode): PipelineExecutionContext => {
  const plan = taskExecutionPlan();
  return {
    plan: {
      ...plan,
      pipelines: { main: { root: node } },
      policies: { ...plan.policies, maximumTotalNodeExecutions: 3 },
    },
    runId: 'run-1',
    scopeId: `sc1_${'e'.repeat(43)}`,
    runInput: null,
    pipelineId: 'main',
    pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
    runtimePath: 'main',
    outputs: new Map(),
    maximumParallelism: 1,
  };
};

const executeTask = async (node: TaskNode, runtime: RecordingAttemptRuntime) => {
  const context = executionContext(node);
  const waitForUnknownOutcome: WaitForUnknownOutcome = async () => ({ kind: 'fail' });
  const executor = new TaskNodeExecutor(
    runtime.execute,
    runtime.wait,
    { write: runtime.write },
    waitForUnknownOutcome,
  );
  const result = await executor.execute(node, context, 'work');
  return { context, result };
};

describe('task node logical attempts', () => {
  it('retries an allowlisted checkpointed failure with a distinct ordered identity', async () => {
    const node: TaskNode = {
      kind: 'task',
      key: 'work',
      retry: {
        maximumAttempts: 3,
        backoff: { kind: 'constant', delayMs: 25 },
        retryableErrorCodes: ['rate_limited'],
      },
    };
    const runtime = new RecordingAttemptRuntime([
      {
        kind: 'failed',
        error: { code: 'rate_limited', message: 'retry later' },
      },
      { kind: 'completed', outcome: 'completed' },
    ]);

    const { result } = await executeTask(node, runtime);

    expect(result).toMatchObject({ kind: 'continued', outcome: 'completed' });
    expect(runtime.delays).toEqual([25]);
    expect(runtime.requests.map(({ attemptOrdinal }) => attemptOrdinal)).toEqual([1, 2]);
    expect(runtime.requests.map(({ attemptId }) => attemptId)).toEqual(
      runtime.requests.map(({ nodeInstanceId, attemptOrdinal }) =>
        createAttemptId({ nodeInstanceId, attemptOrdinal }),
      ),
    );
    expect(new Set(runtime.requests.map(({ attemptId }) => attemptId)).size).toBe(2);
    expect(runtime.events.map(({ type }) => type)).toEqual([
      'nodeExecution.failed',
      'nodeExecution.completed',
    ]);
  });

  it('caps exponential backoff and stops at maximumAttempts', async () => {
    const node: TaskNode = {
      kind: 'task',
      key: 'work',
      retry: {
        maximumAttempts: 3,
        backoff: { kind: 'exponential', initialDelayMs: 10, maximumDelayMs: 15 },
        retryableErrorCodes: ['provider_unavailable'],
      },
    };
    const failure: RunExecutorResult = {
      kind: 'failed',
      error: { code: 'provider_unavailable', message: 'unavailable' },
    };
    const runtime = new RecordingAttemptRuntime([failure, failure, failure]);

    const { result } = await executeTask(node, runtime);

    expect(result).toMatchObject({ kind: 'continued', outcome: 'failed' });
    expect(runtime.delays).toEqual([10, 15]);
    expect(runtime.requests.map(({ attemptOrdinal }) => attemptOrdinal)).toEqual([1, 2, 3]);
  });

  it('does not retry a checkpointed failure outside the allowlist', async () => {
    const node: TaskNode = {
      kind: 'task',
      key: 'work',
      retry: {
        maximumAttempts: 3,
        backoff: { kind: 'constant', delayMs: 25 },
        retryableErrorCodes: ['rate_limited'],
      },
    };
    const runtime = new RecordingAttemptRuntime([
      {
        kind: 'failed',
        error: { code: 'invalid_request', message: 'invalid' },
      },
    ]);

    const { result } = await executeTask(node, runtime);

    expect(result).toMatchObject({ kind: 'continued', outcome: 'failed' });
    expect(runtime.delays).toEqual([]);
    expect(runtime.requests).toHaveLength(1);
  });

  it('closes executor input resolution failure without retrying it', async () => {
    const node: TaskNode = {
      kind: 'task',
      key: 'work',
      retry: {
        maximumAttempts: 3,
        backoff: { kind: 'constant', delayMs: 25 },
        retryableErrorCodes: ['secret_not_found'],
      },
    };
    const runtime = new RecordingAttemptRuntime([
      {
        kind: 'inputResolutionFailed',
        error: { code: 'secret_not_found', message: 'secret detail' },
      },
    ]);

    await executeTask(node, runtime);

    expect(runtime.delays).toEqual([]);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.events).toMatchObject([
      { type: 'inputResolution.failed', data: { errorCode: 'secret_not_found' } },
      { type: 'nodeExecution.failed', data: { attemptOrdinal: 1, errorCode: 'secret_not_found' } },
    ]);
  });

  it('routes a timed out attempt without retrying it', async () => {
    const node: TaskNode = {
      kind: 'task',
      key: 'work',
      retry: {
        maximumAttempts: 3,
        backoff: { kind: 'constant', delayMs: 25 },
        retryableErrorCodes: ['step_timeout'],
      },
    };
    const runtime = new RecordingAttemptRuntime([{ kind: 'timedOut' }]);

    const { result } = await executeTask(node, runtime);

    expect(result).toMatchObject({ kind: 'continued', outcome: 'timedOut' });
    expect(runtime.delays).toEqual([]);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.events).toMatchObject([
      { type: 'nodeExecution.timedOut', data: { attemptOrdinal: 1 } },
    ]);
  });

  it('reports coordinator denial after effectNotFound without dispatching another effect', async () => {
    const node: TaskNode = { kind: 'task', key: 'work' };
    const runtime = new RecordingAttemptRuntime([
      { kind: 'effectNotFound', nextReconciliationRound: 2 },
      { kind: 'executionLimitExceeded' },
    ]);

    const { result } = await executeTask(node, runtime);

    expect(result).toMatchObject({ kind: 'finished', result: { status: 'failed' } });
    expect(runtime.requests.map(({ attemptOrdinal }) => attemptOrdinal)).toEqual([1, 2]);
    expect(runtime.events).toMatchObject([
      { type: 'nodeExecution.failed', data: { attemptOrdinal: 1, errorCode: 'effect_not_found' } },
      {
        type: 'pipeline.invalidState',
        data: { errorCode: 'maximum_total_node_executions_exceeded' },
      },
    ]);
  });

  it('emits recovery exhaustion before failing the attempt', async () => {
    const node: TaskNode = { kind: 'task', key: 'work' };
    const runtime = new RecordingAttemptRuntime([
      { kind: 'recoveryExhausted', reconciliationRound: 3 },
    ]);

    const { result } = await executeTask(node, runtime);

    expect(result).toMatchObject({ kind: 'continued', outcome: 'failed' });
    expect(runtime.events).toMatchObject([
      {
        type: 'nodeExecution.recoveryExhausted',
        data: { attemptOrdinal: 1, reconciliationRound: 3 },
      },
      {
        type: 'nodeExecution.failed',
        data: { attemptOrdinal: 1, errorCode: 'recovery_exhausted' },
      },
    ]);
  });
});
