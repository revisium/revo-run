import { describe, expect, it } from 'vitest';

import type { RunExecutorResult } from '../../src/contracts/executor/run-executor.js';
import type { ExecutionPlan } from '../../src/contracts/run/execution-plan.js';
import type { PipelineEventDraft } from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import { PipelineInterpreter } from '../../src/pipeline/interpreter/pipeline-interpreter.js';
import type { ExecuteNodeEffect } from '../../src/pipeline/interpreter/task-execution-ports.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';

type TaskResponse =
  | Extract<RunExecutorResult, { readonly kind: 'completed' }>
  | { kind: 'cancelled' };

const subpipelinePlan = (nested: boolean, routeOutcome: string): ExecutionPlan =>
  executionPlan(
    {
      kind: 'outcomeSwitch',
      source: { kind: 'subpipeline', key: 'phase', pipelineId: 'child' },
      cases: { [routeOutcome]: end('succeeded') },
      default: end('failed', { outcome: 'unrouted' }),
    },
    {
      pipelines: {
        child: nested
          ? { kind: 'subpipeline', key: 'nested', pipelineId: 'grandchild' }
          : sequence(task('work'), end('succeeded')),
        ...(nested ? { grandchild: sequence(task('work'), end('succeeded')) } : {}),
      },
      bindings: [agentBinding('work', 'worker', { pipelineId: nested ? 'grandchild' : 'child' })],
    },
  );

const executePlan = async (plan: ExecutionPlan, response?: TaskResponse) => {
  const events: PipelineEventDraft[] = [];
  const execute: ExecuteNodeEffect = async (request) => {
    if (response === undefined) {
      throw new Error('Unexpected task execution.');
    }
    if (response.kind === 'cancelled') {
      return response;
    }
    return {
      kind: 'effectResult',
      execution: { kind: 'runNodeExecution', request, result: response },
      nextReconciliationRound: 1,
    };
  };
  const interpreter = new PipelineInterpreter({
    executeEffect: execute,
    waitForRetry: async () => undefined,
    parallel: { execute: async () => Promise.reject(new Error('Unexpected parallel execution.')) },
    repeatIterations: {
      execute: async () => Promise.reject(new Error('Unexpected repeat execution.')),
    },
    mapItems: { execute: async () => Promise.reject(new Error('Unexpected map execution.')) },
    inlineScopes: { registerInlineScopeOwnership: async () => undefined },
    events: { write: async (event) => void events.push(event) },
    waitForDelay: async () => 'elapsed',
    waitForUnknownOutcome: async () => ({ kind: 'fail' }),
    waitForHumanGate: async () => ({ kind: 'fail' }),
    consensus: {
      runner: { execute: async () => Promise.reject(new Error('Unexpected consensus execution.')) },
      wait: async () => Promise.reject(new Error('Unexpected consensus wait.')),
    },
  });
  const result = await interpreter.execute(plan, 'run-1', null, `sc1_${'a'.repeat(43)}`);
  return { events, result };
};

describe('terminal node provenance', () => {
  it.each([false, true])(
    'does not route an N1 terminal through %s nested inline boundary',
    async (nested) => {
      const { events, result } = await executePlan(subpipelinePlan(nested, 'invalid'), {
        kind: 'completed',
        outcome: 'unexpected',
      });

      expect(result).toEqual({
        kind: 'finished',
        provenance: 'terminal',
        result: { status: 'failed', outcome: 'invalid' },
      });
      expect(events.filter(({ type }) => type === 'subpipeline.failed')).toHaveLength(0);
      expect(events.filter(({ type }) => type === 'pipeline.invalidState')).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'does not route cancellation through %s nested inline boundary',
    async (nested) => {
      const { events, result } = await executePlan(subpipelinePlan(nested, 'cancelled'), {
        kind: 'cancelled',
      });

      expect(result).toEqual({
        kind: 'finished',
        provenance: 'terminal',
        result: { status: 'cancelled', outcome: 'cancelled' },
      });
      expect(events.filter(({ type }) => type === 'subpipeline.failed')).toHaveLength(0);
    },
  );

  it('keeps an authored failed End routable at the subpipeline boundary', async () => {
    const plan = executionPlan(
      {
        kind: 'outcomeSwitch',
        source: { kind: 'subpipeline', key: 'phase', pipelineId: 'child' },
        cases: { failed: end('succeeded') },
      },
      { pipelines: { child: end('failed') } },
    );

    const { events, result } = await executePlan(plan);

    expect(result).toEqual({
      kind: 'finished',
      provenance: 'authoredEnd',
      result: { status: 'succeeded', outcome: 'succeeded' },
    });
    expect(events.filter(({ type }) => type === 'subpipeline.failed')).toHaveLength(1);
  });
});
