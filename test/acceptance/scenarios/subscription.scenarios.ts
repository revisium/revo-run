import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectRunStatus,
  failNode,
  routeOutcomes,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const subscriptionScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'subscription',
    name: 'resumes a run subscription from its last durable cursor',
    blockedBy: 'runManagerApi',
    plan: executionPlan(sequence(task('work'), end('succeeded')), {
      bindings: [agentBinding('work', 'developer')],
    }),
    steps: [
      startRun(),
      expectEvent('nodeExecution.started', { path: 'main/work', captureCursorAs: 'started' }),
      { kind: 'resumeSubscription', afterCapturedCursor: 'started' },
      completeNode('main/work'),
      expectEvent('nodeExecution.completed', { path: 'main/work', captureCursorAs: 'completed' }),
      expectEvent('run.completed', { captureCursorAs: 'terminal' }),
      { kind: 'expectCursorOrder', cursors: ['started', 'completed', 'terminal'] },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'subscription',
    name: 'publishes a durable terminal failure event',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(task('work'), { completed: end('succeeded'), failed: end('failed') }),
      {
        bindings: [agentBinding('work', 'developer')],
      },
    ),
    steps: [
      startRun(),
      failNode('main/work', 'execution_failed'),
      expectEvent('nodeExecution.failed', { path: 'main/work', captureCursorAs: 'failed-node' }),
      expectEvent('run.failed', { captureCursorAs: 'failed-run' }),
      { kind: 'expectCursorOrder', cursors: ['failed-node', 'failed-run'] },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'subscription',
    name: 'rejects a subscription cursor that does not belong to the run',
    blockedBy: 'runManagerApi',
    plan: executionPlan(end('succeeded')),
    steps: [
      startRun(),
      { kind: 'resumeSubscription', afterCapturedCursor: 'cursor-from-another-run' },
      { kind: 'expectSubscriptionError', errorCode: 'invalid_run_event_cursor' },
    ],
  }),
  scenario({
    capability: 'subscription',
    name: 'exposes every nested execution through current run details',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'review',
          maximumIterations: 3,
          continueOn: ['rejected'],
          completeOn: ['approved'],
          body: task('reviewer'),
        },
        end('succeeded'),
      ),
      { bindings: [agentBinding('review/reviewer', 'reviewer')] },
    ),
    steps: [
      startRun(),
      completeNode('main/review[1]/reviewer', 'rejected'),
      { kind: 'expectIteration', path: 'main/review', iteration: 2 },
      {
        kind: 'expectRunDetails',
        nodePaths: ['main/review[1]/reviewer', 'main/review[2]/reviewer'],
      },
      expectRunStatus('running'),
    ],
  }),
  scenario({
    capability: 'subscription',
    name: 'resumes a durable subscription cursor after a manager restart',
    blockedBy: 'runManagerApi',
    plan: executionPlan(sequence(task('work'), end('succeeded')), {
      bindings: [agentBinding('work', 'developer')],
    }),
    steps: [
      startRun(),
      expectEvent('nodeExecution.started', { path: 'main/work', captureCursorAs: 'started' }),
      { kind: 'crashManager', moment: 'whileWaiting' },
      { kind: 'restartManager' },
      { kind: 'resumeSubscription', afterCapturedCursor: 'started' },
      completeNode('main/work'),
      expectEvent('nodeExecution.completed', { path: 'main/work' }),
      expectRunStatus('succeeded'),
    ],
  }),
];
