import {
  agentBinding,
  end,
  executionPlan,
  expectEvent,
  expectNodeExecutions,
  expectRunStatus,
  failNode,
  retryPolicy,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

const retryTransientErrors = retryPolicy();

export const cancellationScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'cancellation',
    name: 'cancels an active agent execution cooperatively',
    blockedBy: 'runManagerApi',
    plan: executionPlan(sequence(task('implement'), end('succeeded')), {
      bindings: [agentBinding('implement', 'developer')],
    }),
    steps: [
      startRun(),
      expectNodeExecutions('main/implement'),
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-1' },
      expectEvent('nodeExecution.cancelled', { path: 'main/implement' }),
      expectRunStatus('cancelled'),
    ],
  }),
  scenario({
    capability: 'cancellation',
    name: 'cancels a run while it is waiting for retry backoff',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      sequence(task('review', { retry: retryTransientErrors }), end('succeeded')),
      {
        bindings: [agentBinding('review', 'reviewer')],
      },
    ),
    steps: [
      startRun(),
      failNode('main/review', 'rate_limited'),
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-retry-1' },
      { kind: 'advanceTime', durationMs: 60_000 },
      { kind: 'expectExecutionCount', path: 'main/review', count: 1 },
      expectRunStatus('cancelled'),
    ],
  }),
  scenario({
    capability: 'cancellation',
    name: 'treats repeated cancellation commands as idempotent',
    blockedBy: 'runManagerApi',
    plan: executionPlan(sequence(task('work'), end('succeeded')), {
      bindings: [agentBinding('work', 'developer')],
    }),
    steps: [
      startRun(),
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-same' },
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-same' },
      expectEvent('run.cancelled'),
      expectRunStatus('cancelled'),
    ],
  }),
  scenario({
    capability: 'cancellation',
    name: 'keeps a completed run terminal after a later cancellation request',
    blockedBy: 'runManagerApi',
    plan: executionPlan(end('succeeded')),
    steps: [
      startRun(),
      expectRunStatus('succeeded'),
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-completed-1' },
      expectEvent('run.cancellationRejected'),
      expectRunStatus('succeeded'),
    ],
  }),
];
