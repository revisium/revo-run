import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectRunStatus,
  fromNodeOutput,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const dataReferenceFailureScenarios: readonly RunScenario[] = [
  scenario({
    intentId: 'rr-066',
    category: 'dataFlow',
    name: 'fails deterministically when a referenced output key is missing',
    requiredCapabilities: ['missingOutputKeyFailure'],
    plan: executionPlan(
      sequence(
        task('produce'),
        task('consume', {
          input: { payload: fromNodeOutput('produce', undefined, 'missing') },
        }),
        end('succeeded'),
      ),
      {
        bindings: [agentBinding('produce', 'producer'), agentBinding('consume', 'consumer')],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/produce', 'completed', { present: true }),
      {
        kind: 'failInputResolution',
        path: 'main/consume',
        errorCode: 'output_key_not_found',
      },
      expectEvent('inputResolution.failed', { path: 'main/consume' }),
      { kind: 'expectNoNodeExecution', path: 'main/consume' },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    intentId: 'rr-067',
    category: 'dataFlow',
    name: 'fails deterministically when a referenced JSON pointer is missing',
    requiredCapabilities: ['missingJsonPointerFailure'],
    plan: executionPlan(
      sequence(
        task('produce'),
        task('consume', { input: { payload: fromNodeOutput('produce', '/missing') } }),
        end('succeeded'),
      ),
      {
        bindings: [agentBinding('produce', 'producer'), agentBinding('consume', 'consumer')],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/produce', 'completed', { present: true }),
      {
        kind: 'failInputResolution',
        path: 'main/consume',
        errorCode: 'json_pointer_not_found',
      },
      expectEvent('inputResolution.failed', { path: 'main/consume' }),
      { kind: 'expectNoNodeExecution', path: 'main/consume' },
      expectRunStatus('failed'),
    ],
  }),
];
