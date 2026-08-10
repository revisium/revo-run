import {
  advanceTime,
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectAgentExecution,
  expectEvent,
  expectNodeInput,
  expectNodeExecutions,
  expectRunStatus,
  expectVersionedScriptExecution,
  failNode,
  fromNodeOutput,
  fromRunInput,
  routeOutcomes,
  scenario,
  scriptBinding,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const executorScenarios: readonly RunScenario[] = [
  scenario({
    intentId: 'rr-001',
    category: 'agentExecution',
    name: 'executes an agent and passes its output to a script',
    requiredCapabilities: [
      'agentTaskExecution',
      'versionedScriptTaskExecution',
      'nodeOutputDataFlow',
    ],
    plan: executionPlan(
      sequence(
        task('implement', { input: { task: fromRunInput('/task') } }),
        task('create-pr', { input: { branch: fromNodeOutput('implement', '/branch') } }),
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('implement', 'developer'),
          scriptBinding('create-pr', 'github.create-pull-request'),
        ],
      },
    ),
    steps: [
      startRun({ task: 'Implement feature' }),
      expectAgentExecution('main/implement', 'developer'),
      completeNode('main/implement', 'completed', { branch: 'feature/example' }),
      expectVersionedScriptExecution('main/create-pr', 'github.create-pull-request', 1),
      expectNodeInput('main/create-pr', { branch: 'feature/example' }),
      completeNode('main/create-pr', 'completed', { pullRequest: 42 }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-002',
    category: 'agentExecution',
    name: 'routes a permanent agent failure explicitly',
    requiredCapabilities: ['agentTaskExecution', 'taskFailureRouting', 'singleAttemptExecution'],
    plan: executionPlan(
      routeOutcomes(task('review'), {
        completed: end('succeeded'),
        failed: end('failed'),
      }),
      { bindings: [agentBinding('review', 'reviewer')] },
    ),
    steps: [
      startRun(),
      failNode('main/review', 'invalid_request'),
      { kind: 'expectExecutionCount', path: 'main/review', count: 1 },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    intentId: 'rr-003',
    category: 'agentExecution',
    name: 'times out a bounded agent execution and routes the timeout',
    requiredCapabilities: ['agentTaskExecution', 'taskTimeoutRouting', 'dbosSafeTimeAdvancement'],
    plan: executionPlan(
      routeOutcomes(task('review', { timeoutMs: 60_000 }), {
        completed: end('succeeded'),
        timedOut: end('failed'),
      }),
      { bindings: [agentBinding('review', 'reviewer')] },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/review'),
      advanceTime(60_000),
      expectEvent('nodeExecution.timedOut', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    intentId: 'rr-004',
    category: 'scriptExecution',
    name: 'executes an immutable versioned script binding',
    requiredCapabilities: ['versionedScriptTaskExecution'],
    plan: executionPlan(sequence(task('validate'), end('succeeded')), {
      bindings: [scriptBinding('validate', 'repository.validate', { revision: 2 })],
    }),
    steps: [
      startRun(),
      expectVersionedScriptExecution('main/validate', 'repository.validate', 2),
      completeNode('main/validate'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-005',
    category: 'scriptExecution',
    name: 'routes a permanent script failure without retrying it',
    requiredCapabilities: [
      'versionedScriptTaskExecution',
      'taskFailureRouting',
      'singleAttemptExecution',
    ],
    plan: executionPlan(
      routeOutcomes(task('validate'), {
        completed: end('succeeded'),
        failed: end('failed'),
      }),
      { bindings: [scriptBinding('validate', 'repository.validate')] },
    ),
    steps: [
      startRun(),
      failNode('main/validate', 'invalid_repository'),
      { kind: 'expectExecutionCount', path: 'main/validate', count: 1 },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    intentId: 'rr-006',
    category: 'scriptExecution',
    name: 'times out a bounded script execution',
    requiredCapabilities: [
      'versionedScriptTaskExecution',
      'taskTimeoutRouting',
      'dbosSafeTimeAdvancement',
    ],
    plan: executionPlan(
      routeOutcomes(task('deploy', { timeoutMs: 120_000 }), {
        completed: end('succeeded'),
        timedOut: end('failed'),
      }),
      { bindings: [scriptBinding('deploy', 'deployment.create')] },
    ),
    steps: [
      startRun(),
      advanceTime(120_000),
      expectEvent('nodeExecution.timedOut', { path: 'main/deploy' }),
      expectRunStatus('failed'),
    ],
  }),
];
