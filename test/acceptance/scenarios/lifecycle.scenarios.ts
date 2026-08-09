import {
  advanceTime,
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectNodeExecutions,
  expectRunStatus,
  scenario,
  scriptBinding,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const lifecycleScenarios: readonly RunScenario[] = [
  scenario({
    intentId: 'rr-075',
    category: 'delay',
    name: 'survives a manager restart while waiting for a durable delay',
    requiredCapabilities: [
      'durableDelayRecovery',
      'managerRestartRecovery',
      'dbosSafeTimeAdvancement',
    ],
    plan: executionPlan(
      sequence({ kind: 'delay', key: 'cooldown', durationMs: 60_000 }, end('succeeded')),
    ),
    steps: [
      startRun(),
      advanceTime(30_000),
      { kind: 'crashManager', moment: 'whileWaiting' },
      { kind: 'restartManager' },
      advanceTime(30_000),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-076',
    category: 'delay',
    name: 'cancels a durable delay without waiting for its deadline',
    requiredCapabilities: ['durableDelayCancellation', 'dbosSafeTimeAdvancement'],
    plan: executionPlan(
      sequence({ kind: 'delay', key: 'cooldown', durationMs: 60_000 }, end('succeeded')),
    ),
    steps: [
      startRun(),
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-delay-1' },
      advanceTime(60_000),
      expectEvent('delay.cancelled', { path: 'main/cooldown' }),
      expectRunStatus('cancelled'),
    ],
  }),
  scenario({
    intentId: 'rr-077',
    category: 'cancellation',
    name: 'cancels every active parallel child without leaving detached work',
    requiredCapabilities: ['parallelCancellation'],
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'work',
          branches: { a: task('a'), b: task('b'), c: task('c') },
          join: {
            kind: 'all',
            successfulOutcomes: ['completed'],
            remaining: 'cancel',
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('work/a', 'developer'),
          agentBinding('work/b', 'developer'),
          agentBinding('work/c', 'developer'),
        ],
      },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/work/a', 'main/work/b', 'main/work/c'),
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-parallel-1' },
      expectEvent('nodeExecution.cancelled', { path: 'main/work/a' }),
      expectEvent('nodeExecution.cancelled', { path: 'main/work/b' }),
      expectEvent('nodeExecution.cancelled', { path: 'main/work/c' }),
      expectRunStatus('cancelled'),
    ],
  }),
  scenario({
    intentId: 'rr-078',
    category: 'recovery',
    name: 'recovers parallel executions without duplicate effects',
    requiredCapabilities: ['parallelRecovery', 'managerRestartRecovery', 'deduplicatedExecution'],
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'work',
          branches: { a: task('a'), b: task('b') },
          join: {
            kind: 'all',
            successfulOutcomes: ['completed'],
            remaining: 'drain',
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [scriptBinding('work/a', 'effect.a'), scriptBinding('work/b', 'effect.b')],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/work/a'),
      { kind: 'crashManager', moment: 'afterEffect' },
      { kind: 'restartManager' },
      { kind: 'expectNoDuplicateExecution', path: 'main/work/a' },
      completeNode('main/work/b'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-079',
    category: 'concurrency',
    name: 'enforces the plan-wide active execution limit across parallel nodes',
    requiredCapabilities: ['planWideConcurrencyLimit'],
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'work',
          branches: { a: task('a'), b: task('b'), c: task('c') },
          join: {
            kind: 'all',
            successfulOutcomes: ['completed'],
            remaining: 'drain',
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('work/a', 'developer'),
          agentBinding('work/b', 'developer'),
          agentBinding('work/c', 'developer'),
        ],
        policies: { maximumActiveNodeExecutions: 2 },
      },
    ),
    steps: [
      startRun(),
      { kind: 'expectMaximumActiveExecutions', count: 2 },
      completeNode('main/work/a'),
      expectNodeExecutions('main/work/c'),
      completeNode('main/work/b'),
      completeNode('main/work/c'),
      expectRunStatus('succeeded'),
    ],
  }),
];
