import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectNodeInput,
  expectNodeExecutions,
  expectRunStatus,
  fromIterationInput,
  fromIterationOutput,
  fromRunInput,
  literal,
  routeOutcomes,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const repeatScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'repeat',
    name: 'passes the previous iteration output into the next review iteration',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'review-cycle',
          maximumIterations: 3,
          continueOn: ['rejected'],
          completeOn: ['approved'],
          initialInput: {
            change: fromRunInput('/change'),
            feedback: literal(null),
          },
          nextInput: {
            change: fromIterationOutput('/change'),
            feedback: fromIterationOutput('/feedback'),
          },
          body: task('review', {
            input: {
              change: fromIterationInput('/change'),
              feedback: fromIterationInput('/feedback'),
            },
          }),
        },
        end('succeeded'),
      ),
      { bindings: [agentBinding('review-cycle/review', 'reviewer')] },
    ),
    steps: [
      startRun({ change: 'initial' }),
      { kind: 'expectIteration', path: 'main/review-cycle', iteration: 1 },
      expectNodeInput('main/review-cycle[1]/review', {
        change: 'initial',
        feedback: null,
      }),
      completeNode('main/review-cycle[1]/review', 'rejected', {
        change: 'revision-2',
        feedback: 'add tests',
      }),
      { kind: 'expectIteration', path: 'main/review-cycle', iteration: 2 },
      expectNodeExecutions('main/review-cycle[2]/review'),
      expectNodeInput('main/review-cycle[2]/review', {
        change: 'revision-2',
        feedback: 'add tests',
      }),
      completeNode('main/review-cycle[2]/review', 'approved'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'repeat',
    name: 'supports a bounded repeat nested inside another repeat',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        {
          kind: 'repeat',
          key: 'outer',
          maximumIterations: 2,
          continueOn: ['exhausted'],
          completeOn: ['completed'],
          body: {
            kind: 'repeat',
            key: 'inner',
            maximumIterations: 2,
            continueOn: ['retry'],
            completeOn: ['completed'],
            body: task('work'),
          },
        },
        end('succeeded'),
      ),
      { bindings: [agentBinding('outer/inner/work', 'developer')] },
    ),
    steps: [
      startRun(),
      completeNode('main/outer[1]/inner[1]/work', 'retry'),
      completeNode('main/outer[1]/inner[2]/work', 'retry'),
      { kind: 'expectIteration', path: 'main/outer', iteration: 2 },
      { kind: 'expectIteration', path: 'main/outer[2]/inner', iteration: 1 },
      completeNode('main/outer[2]/inner[1]/work', 'completed'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'repeat',
    name: 'routes an exhausted repeat after reaching its iteration limit',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'repeat',
          key: 'review',
          maximumIterations: 2,
          continueOn: ['rejected'],
          completeOn: ['approved'],
          body: task('reviewer'),
        },
        { completed: end('succeeded'), exhausted: end('failed') },
      ),
      { bindings: [agentBinding('review/reviewer', 'reviewer')] },
    ),
    steps: [
      startRun(),
      completeNode('main/review[1]/reviewer', 'rejected'),
      completeNode('main/review[2]/reviewer', 'rejected'),
      expectEvent('repeat.exhausted', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'repeat',
    name: 'rejects an unbounded repeat during plan validation',
    blockedBy: 'pipelineContract',
    plan: executionPlan({
      kind: 'repeat',
      key: 'review',
      maximumIterations: 0,
      continueOn: ['rejected'],
      completeOn: ['approved'],
      body: task('reviewer'),
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'invalid_repeat_bound' }],
  }),
];
