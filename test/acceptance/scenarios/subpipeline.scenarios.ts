import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectNodeInput,
  expectNodeExecutions,
  expectRunStatus,
  failNode,
  fromNodeOutput,
  fromPipelineInput,
  fromRunInput,
  routeOutcomes,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const subpipelineScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'subpipeline',
    name: 'passes immutable input into a subpipeline and returns its output',
    plan: executionPlan(
      sequence(
        {
          kind: 'subpipeline',
          key: 'review',
          pipelineId: 'review.v1',
          input: { change: fromRunInput('/change') },
        },
        task('summarize', { input: { review: fromNodeOutput('review') } }),
        end('succeeded'),
      ),
      {
        pipelines: {
          'review.v1': sequence(
            task('reviewer', { input: { change: fromPipelineInput('/change') } }),
            end('succeeded', {
              outcome: 'completed',
              output: { result: fromNodeOutput('reviewer', '/verdict') },
            }),
          ),
        },
        bindings: [
          agentBinding('reviewer', 'reviewer', { pipelineId: 'review.v1' }),
          agentBinding('summarize', 'writer'),
        ],
      },
    ),
    steps: [
      startRun({ change: { id: 'change-1' } }),
      expectNodeExecutions('main/review/reviewer'),
      expectNodeInput('main/review/reviewer', { change: { id: 'change-1' } }),
      completeNode('main/review/reviewer', 'completed', { verdict: 'approved' }),
      expectNodeExecutions('main/summarize'),
      expectNodeInput('main/summarize', { review: 'approved' }),
      completeNode('main/summarize'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'subpipeline',
    name: 'routes a failed subpipeline outcome in its parent',
    plan: executionPlan(
      routeOutcomes(
        { kind: 'subpipeline', key: 'review', pipelineId: 'review.v1' },
        { completed: end('succeeded'), failed: end('failed') },
      ),
      {
        pipelines: {
          'review.v1': routeOutcomes(task('reviewer'), {
            completed: end('succeeded', { outcome: 'completed' }),
            failed: end('failed'),
          }),
        },
        bindings: [agentBinding('reviewer', 'reviewer', { pipelineId: 'review.v1' })],
      },
    ),
    steps: [
      startRun(),
      failNode('main/review/reviewer', 'review_failed'),
      expectEvent('subpipeline.failed', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'subpipeline',
    name: 'rejects a plan that references a missing subpipeline',
    plan: executionPlan({ kind: 'subpipeline', key: 'review', pipelineId: 'missing.v1' }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'pipeline_not_found' }],
  }),
];
