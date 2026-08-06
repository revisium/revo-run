import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectRunStatus,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const executionValidationScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'validation',
    name: 'fails an unhandled custom task outcome instead of treating it as success',
    plan: executionPlan(sequence(task('review'), end('succeeded')), {
      bindings: [agentBinding('review', 'reviewer')],
    }),
    steps: [
      startRun(),
      completeNode('main/review', 'needs-special-routing'),
      expectEvent('pipeline.invalidState', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'validation',
    name: 'does not select inherited outcome routes',
    plan: executionPlan(
      {
        kind: 'outcomeSwitch',
        source: task('review'),
        cases: { completed: end('succeeded') },
        default: end('succeeded', { outcome: 'defaulted' }),
      },
      { bindings: [agentBinding('review', 'reviewer')] },
    ),
    steps: [startRun(), completeNode('main/review', 'constructor'), expectRunStatus('succeeded')],
  }),
];
