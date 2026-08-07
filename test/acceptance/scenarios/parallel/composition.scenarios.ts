import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectNodeInput,
  expectNodeExecutions,
  expectRunDetails,
  expectRunStatus,
  fromNodeOutput,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../../dsl/run-scenario.js';

export const parallelCompositionScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'dataFlow',
    name: 'makes parallel branch outputs available after the join',
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'research',
          branches: { first: task('first'), second: task('second') },
          join: {
            kind: 'all',
            successfulOutcomes: ['completed'],
            remaining: 'drain',
          },
        },
        task('combine', {
          input: {
            first: fromNodeOutput('research/first'),
            second: fromNodeOutput('research/second'),
          },
        }),
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('research/first', 'researcher'),
          agentBinding('research/second', 'researcher'),
          agentBinding('combine', 'writer'),
        ],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/research/first', 'completed', 'first'),
      completeNode('main/research/second', 'completed', 'second'),
      expectNodeInput('main/combine', { first: 'first', second: 'second' }),
      completeNode('main/combine'),
      expectRunStatus('succeeded'),
      expectRunDetails('main/research/first', 'main/research/second', 'main/combine'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'applies the run parallelism limit across nested parallel branches',
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'work',
          branches: {
            group: {
              kind: 'parallel',
              key: 'inner',
              branches: { a: task('a'), b: task('b') },
              join: {
                kind: 'all',
                successfulOutcomes: ['completed'],
                remaining: 'drain',
              },
            },
            standalone: task('c'),
          },
          join: {
            kind: 'all',
            successfulOutcomes: ['completed'],
            remaining: 'drain',
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('work/inner/a', 'developer'),
          agentBinding('work/inner/b', 'developer'),
          agentBinding('work/c', 'developer'),
        ],
        policies: { maximumActiveNodeExecutions: 2 },
      },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/work/inner/a', 'main/work/c'),
      { kind: 'expectMaximumActiveExecutions', count: 2 },
      completeNode('main/work/inner/a'),
      expectNodeExecutions('main/work/inner/b'),
      completeNode('main/work/inner/b'),
      completeNode('main/work/c'),
      expectRunStatus('succeeded'),
    ],
  }),
];
