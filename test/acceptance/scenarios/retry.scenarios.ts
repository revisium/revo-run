import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectNodeExecutions,
  expectRunStatus,
  failNode,
  retryPolicy,
  routeOutcomes,
  scenario,
  scriptBinding,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

const retryTransientErrors = retryPolicy();

export const retryScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'retry',
    name: 'retries a transient agent failure with durable backoff',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(task('review', { retry: retryTransientErrors }), end('succeeded')),
      {
        bindings: [agentBinding('review', 'reviewer')],
      },
    ),
    steps: [
      startRun(),
      failNode('main/review', 'rate_limited', 1),
      { kind: 'advanceTime', durationMs: 1_000 },
      expectNodeExecutions('main/review'),
      completeNode('main/review', 'completed', undefined, 2),
      { kind: 'expectExecutionCount', path: 'main/review', count: 2 },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'retry',
    name: 'stops retrying a script after the configured attempt limit',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(task('publish', { retry: retryTransientErrors }), {
        completed: end('succeeded'),
        failed: end('failed'),
      }),
      { bindings: [scriptBinding('publish', 'package.publish')] },
    ),
    steps: [
      startRun(),
      failNode('main/publish', 'provider_unavailable', 1),
      { kind: 'advanceTime', durationMs: 1_000 },
      failNode('main/publish', 'provider_unavailable', 2),
      { kind: 'advanceTime', durationMs: 2_000 },
      failNode('main/publish', 'provider_unavailable', 3),
      { kind: 'expectExecutionCount', path: 'main/publish', count: 3 },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'retry',
    name: 'does not retry an error code outside the retry allowlist',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(task('publish', { retry: retryTransientErrors }), {
        completed: end('succeeded'),
        failed: end('failed'),
      }),
      { bindings: [scriptBinding('publish', 'package.publish')] },
    ),
    steps: [
      startRun(),
      failNode('main/publish', 'invalid_package'),
      { kind: 'expectExecutionCount', path: 'main/publish', count: 1 },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'retry',
    name: 'resumes durable retry backoff after a manager restart',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(task('review', { retry: retryTransientErrors }), end('succeeded')),
      { bindings: [agentBinding('review', 'reviewer')] },
    ),
    steps: [
      startRun(),
      failNode('main/review', 'rate_limited'),
      { kind: 'advanceTime', durationMs: 400 },
      { kind: 'crashManager', moment: 'whileWaiting' },
      { kind: 'restartManager' },
      { kind: 'advanceTime', durationMs: 600 },
      expectNodeExecutions('main/review'),
      completeNode('main/review', 'completed', undefined, 2),
      { kind: 'expectExecutionCount', path: 'main/review', count: 2 },
      expectRunStatus('succeeded'),
    ],
  }),
];
