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
    capability: 'agentExecution',
    name: 'executes an agent and passes its output to a script',
    blockedBy: 'runRuntime',
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
      expectNodeExecutions('main/implement'),
      completeNode('main/implement', 'completed', { branch: 'feature/example' }),
      expectNodeExecutions('main/create-pr'),
      expectNodeInput('main/create-pr', { branch: 'feature/example' }),
      completeNode('main/create-pr', 'completed', { pullRequest: 42 }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'agentExecution',
    name: 'routes a permanent agent failure explicitly',
    blockedBy: 'pipelineContract',
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
    capability: 'agentExecution',
    name: 'times out a bounded agent execution and routes the timeout',
    blockedBy: 'pipelineContract',
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
      { kind: 'advanceTime', durationMs: 60_000 },
      expectEvent('nodeExecution.timedOut', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'scriptExecution',
    name: 'executes an immutable versioned script binding',
    blockedBy: 'runRuntime',
    plan: executionPlan(sequence(task('validate'), end('succeeded')), {
      bindings: [scriptBinding('validate', 'repository.validate', { version: '2.1.0' })],
    }),
    steps: [
      startRun(),
      expectNodeExecutions('main/validate'),
      completeNode('main/validate'),
      expectEvent('nodeExecution.completed', { path: 'main/validate' }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'scriptExecution',
    name: 'routes a permanent script failure without retrying it',
    blockedBy: 'pipelineContract',
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
    capability: 'scriptExecution',
    name: 'times out a bounded script execution',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(task('deploy', { timeoutMs: 120_000 }), {
        completed: end('succeeded'),
        timedOut: end('failed'),
      }),
      { bindings: [scriptBinding('deploy', 'deployment.create')] },
    ),
    steps: [
      startRun(),
      { kind: 'advanceTime', durationMs: 120_000 },
      expectEvent('nodeExecution.timedOut', { path: 'main/deploy' }),
      expectRunStatus('failed'),
    ],
  }),
];
