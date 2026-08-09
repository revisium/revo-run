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
    intentId: 'rr-100',
    category: 'validation',
    name: 'rejects structural nodes beyond the configured nesting bound',
    requiredCapabilities: ['structuralNestingValidation'],
    plan: executionPlan(sequence(sequence(end('succeeded'))), {
      policies: { maximumNodeNestingDepth: 2 },
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'node_depth_exceeded' }],
  }),
  scenario({
    intentId: 'rr-101',
    category: 'validation',
    name: 'rejects subpipeline composition beyond the configured depth bound',
    requiredCapabilities: ['subpipelineDepthValidation'],
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
    intentId: 'rr-102',
    category: 'validation',
    name: 'rejects direct subpipeline recursion',
    requiredCapabilities: ['subpipelineRecursionValidation'],
    plan: executionPlan({ kind: 'subpipeline', key: 'self', pipelineId: 'main' }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'subpipeline_cycle' }],
  }),
  scenario({
    intentId: 'rr-103',
    category: 'validation',
    name: 'rejects indirect subpipeline recursion',
    requiredCapabilities: ['subpipelineRecursionValidation'],
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
