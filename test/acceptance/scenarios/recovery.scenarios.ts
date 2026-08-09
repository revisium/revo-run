import {
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectNodeExecutions,
  expectRunStatus,
  jsonOutput,
  routeOutcomes,
  scenario,
  scriptBinding,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

const reconcileOrAsk = {
  reconciliation: 'required',
  maximumAttempts: 3,
  timeoutMs: 30_000,
  unknownOutcome: 'requireHumanResolution',
} as const;

const reconcileOrFail = {
  ...reconcileOrAsk,
  unknownOutcome: 'fail',
} as const;

export const recoveryScenarios: readonly RunScenario[] = [
  scenario({
    intentId: 'rr-011',
    category: 'recovery',
    name: 'adopts a reconciled external effect after a crash before its checkpoint',
    requiredCapabilities: [
      'effectReconciliation',
      'managerRestartRecovery',
      'deduplicatedExecution',
    ],
    plan: executionPlan(sequence(task('merge', { recovery: reconcileOrAsk }), end('succeeded')), {
      bindings: [scriptBinding('merge', 'github.merge')],
    }),
    steps: [
      startRun(),
      { kind: 'crashManager', moment: 'afterEffect' },
      { kind: 'restartManager' },
      {
        kind: 'reconcileNode',
        path: 'main/merge',
        result: 'effectCompleted',
        output: jsonOutput({ mergeCommit: 'abc123' }),
      },
      { kind: 'expectNoDuplicateExecution', path: 'main/merge' },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-012',
    category: 'recovery',
    name: 'requires attributed human resolution when reconciliation returns unknown',
    requiredCapabilities: [
      'effectReconciliation',
      'unknownOutcomeResolution',
      'managerRestartRecovery',
      'deduplicatedExecution',
    ],
    plan: executionPlan(sequence(task('publish', { recovery: reconcileOrAsk }), end('succeeded')), {
      bindings: [scriptBinding('publish', 'package.publish')],
    }),
    steps: [
      startRun(),
      { kind: 'crashManager', moment: 'afterEffect' },
      { kind: 'restartManager' },
      { kind: 'reconcileNode', path: 'main/publish', result: 'outcomeUnknown' },
      expectEvent('nodeExecution.outcomeUnknown', { path: 'main/publish' }),
      {
        kind: 'resolveUnknownOutcome',
        path: 'main/publish',
        resolution: 'adoptSuccess',
        actorId: 'release-manager',
        commandId: 'resolve-publish-1',
      },
      { kind: 'expectNoDuplicateExecution', path: 'main/publish' },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-013',
    category: 'recovery',
    name: 'fails deterministically when an unknown effect is configured to fail',
    requiredCapabilities: ['effectReconciliation', 'unknownOutcomeFailure'],
    plan: executionPlan(
      routeOutcomes(task('notify', { recovery: reconcileOrFail }), {
        completed: end('succeeded'),
        failed: end('failed'),
      }),
      { bindings: [scriptBinding('notify', 'notification.send')] },
    ),
    steps: [
      startRun(),
      { kind: 'crashManager', moment: 'afterEffect' },
      { kind: 'restartManager' },
      { kind: 'reconcileNode', path: 'main/notify', result: 'outcomeUnknown' },
      expectEvent('nodeExecution.failed', { path: 'main/notify' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    intentId: 'rr-014',
    category: 'recovery',
    name: 'executes an effect once after restarting before the effect begins',
    requiredCapabilities: ['managerRestartRecovery', 'deduplicatedExecution'],
    plan: executionPlan(sequence(task('commit', { recovery: reconcileOrAsk }), end('succeeded')), {
      bindings: [scriptBinding('commit', 'git.commit')],
    }),
    steps: [
      startRun(),
      { kind: 'crashManager', moment: 'beforeEffect' },
      { kind: 'restartManager' },
      completeNode('main/commit'),
      { kind: 'expectExecutionCount', path: 'main/commit', count: 1 },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-015',
    category: 'recovery',
    name: 'fails after exhausting bounded reconciliation attempts',
    requiredCapabilities: ['effectReconciliation', 'reconciliationAttemptLimit'],
    plan: executionPlan(
      routeOutcomes(task('deploy', { recovery: reconcileOrFail }), {
        completed: end('succeeded'),
        failed: end('failed'),
      }),
      { bindings: [scriptBinding('deploy', 'deployment.create')] },
    ),
    steps: [
      startRun(),
      { kind: 'crashManager', moment: 'afterEffect' },
      { kind: 'restartManager' },
      { kind: 'reconcileNode', path: 'main/deploy', result: 'reconciliationFailed' },
      { kind: 'reconcileNode', path: 'main/deploy', result: 'reconciliationFailed' },
      { kind: 'reconcileNode', path: 'main/deploy', result: 'reconciliationFailed' },
      expectEvent('nodeExecution.recoveryExhausted', { path: 'main/deploy' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    intentId: 'rr-016',
    category: 'recovery',
    name: 'retries safely after reconciliation proves the external effect is absent',
    requiredCapabilities: ['effectReconciliation', 'deduplicatedExecution'],
    plan: executionPlan(sequence(task('publish', { recovery: reconcileOrAsk }), end('succeeded')), {
      bindings: [scriptBinding('publish', 'package.publish')],
    }),
    steps: [
      startRun(),
      { kind: 'crashManager', moment: 'afterEffect' },
      { kind: 'restartManager' },
      { kind: 'reconcileNode', path: 'main/publish', result: 'effectNotFound' },
      expectNodeExecutions('main/publish'),
      completeNode('main/publish', 'completed', { version: '1.0.0' }, 2),
      { kind: 'expectExecutionCount', path: 'main/publish', count: 2 },
      expectRunStatus('succeeded'),
    ],
  }),
];
