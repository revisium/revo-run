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
} from '../../../dsl/run-scenario.js';

export const parallelCancelScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'parallelExecution',
    name: 'cancels remaining branches after a threshold join succeeds',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'review',
          branches: { a: task('a'), b: task('b'), c: task('c') },
          join: {
            kind: 'threshold',
            count: 2,
            successfulOutcomes: ['completed'],
            remaining: 'cancel',
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('review/a', 'reviewer'),
          agentBinding('review/b', 'reviewer'),
          agentBinding('review/c', 'reviewer'),
        ],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/review/a'),
      completeNode('main/review/b'),
      expectEvent('nodeExecution.cancelled', { path: 'main/review/c' }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'fails a threshold join when the threshold becomes unreachable',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'parallel',
          key: 'review',
          branches: { a: task('a'), b: task('b'), c: task('c') },
          join: {
            kind: 'threshold',
            count: 2,
            successfulOutcomes: ['completed'],
            remaining: 'cancel',
          },
        },
        { completed: end('succeeded'), failed: end('failed') },
      ),
      {
        bindings: [
          agentBinding('review/a', 'reviewer'),
          agentBinding('review/b', 'reviewer'),
          agentBinding('review/c', 'reviewer'),
        ],
      },
    ),
    steps: [
      startRun(),
      failNode('main/review/a', 'review_failed'),
      failNode('main/review/b', 'review_failed'),
      expectEvent('nodeExecution.cancelled', { path: 'main/review/c' }),
      expectRunStatus('failed'),
    ],
  }),
];
