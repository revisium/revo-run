import {
  end,
  executionPlan,
  scenario,
  sequence,
  startRun,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const validationDepthScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'validation',
    name: 'rejects structural nodes beyond the configured nesting bound',
    blockedBy: 'pipelineContract',
    plan: executionPlan(sequence(sequence(end('succeeded'))), {
      policies: { maximumNodeNestingDepth: 2 },
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'node_depth_exceeded' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects subpipeline composition beyond the configured depth bound',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      { kind: 'subpipeline', key: 'child', pipelineId: 'child' },
      {
        pipelines: {
          child: { kind: 'subpipeline', key: 'grandchild', pipelineId: 'grandchild' },
          grandchild: end('succeeded'),
        },
        policies: { maximumSubpipelineDepth: 2 },
      },
    ),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'subpipeline_depth_exceeded' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects direct subpipeline recursion',
    blockedBy: 'pipelineContract',
    plan: executionPlan({ kind: 'subpipeline', key: 'self', pipelineId: 'main' }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'subpipeline_cycle' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects indirect subpipeline recursion',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      { kind: 'subpipeline', key: 'child', pipelineId: 'child' },
      {
        pipelines: {
          child: { kind: 'subpipeline', key: 'parent', pipelineId: 'main' },
        },
      },
    ),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'subpipeline_cycle' }],
  }),
];
