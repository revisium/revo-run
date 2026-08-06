import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectNodeExecutions,
  expectRunStatus,
  fromNodeOutput,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const branchScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'dataFlow',
    name: 'selects a branch from a completed node output',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        task('classify'),
        {
          kind: 'branch',
          key: 'route',
          value: fromNodeOutput('classify', '/risk'),
          cases: {
            high: task('security-review'),
            low: end('succeeded'),
          },
          default: end('succeeded', { outcome: 'manual-review' }),
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('classify', 'classifier'),
          agentBinding('route/security-review', 'security-reviewer'),
        ],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/classify', 'completed', { risk: 'high' }),
      expectNodeExecutions('main/route/security-review'),
      completeNode('main/route/security-review'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'uses an explicit default branch for an uncovered value',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      sequence(task('classify'), {
        kind: 'branch',
        key: 'route',
        value: fromNodeOutput('classify', '/risk'),
        cases: { low: end('succeeded') },
        default: end('succeeded', { outcome: 'manual-review' }),
      }),
      { bindings: [agentBinding('classify', 'classifier')] },
    ),
    steps: [
      startRun(),
      completeNode('main/classify', 'completed', { risk: 'unknown' }),
      expectEvent('pipeline.branchDefaulted', { path: 'main/route' }),
      expectRunStatus('succeeded'),
    ],
  }),
];
