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
    intentId: 'rr-080',
    category: 'subscription',
    name: 'resumes a run subscription from its last durable cursor',
    requiredCapabilities: ['runEventSubscription'],
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
    intentId: 'rr-081',
    category: 'subscription',
    name: 'publishes a durable terminal failure event',
    requiredCapabilities: ['terminalFailureEvent'],
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
    intentId: 'rr-082',
    category: 'subscription',
    name: 'rejects a subscription cursor that does not belong to the run',
    requiredCapabilities: ['subscriptionCursorValidation'],
    plan: executionPlan(end('succeeded')),
    steps: [
      startRun(),
      { kind: 'resumeSubscription', afterCapturedCursor: 'cursor-from-another-run' },
      { kind: 'expectSubscriptionError', errorCode: 'invalid_run_event_cursor' },
    ],
  }),
  scenario({
    intentId: 'rr-083',
    category: 'subscription',
    name: 'exposes every nested execution through current run details',
    requiredCapabilities: ['runDetailsProjection'],
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
    intentId: 'rr-084',
    category: 'subscription',
    name: 'resumes a durable subscription cursor after a manager restart',
    requiredCapabilities: ['subscriptionRecovery', 'managerRestartRecovery'],
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
