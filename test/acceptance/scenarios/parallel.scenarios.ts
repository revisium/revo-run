import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectNodeExecutions,
  expectRunStatus,
  failNode,
  routeOutcomes,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const parallelScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'parallelExecution',
    name: 'waits for every successful branch at an all join',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'checks',
          branches: {
            security: task('security'),
            tests: task('tests'),
          },
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
          agentBinding('checks/security', 'security-reviewer'),
          agentBinding('checks/tests', 'test-runner'),
        ],
      },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/checks/security', 'main/checks/tests'),
      completeNode('main/checks/security'),
      expectRunStatus('running'),
      completeNode('main/checks/tests'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'runs a multi-step pipeline as one parallel branch',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'checks',
          branches: {
            security: sequence(task('scan'), task('report')),
            tests: task('tests'),
          },
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
          agentBinding('checks/scan', 'security-reviewer'),
          agentBinding('checks/report', 'security-reviewer'),
          agentBinding('checks/tests', 'test-runner'),
        ],
      },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/checks/scan', 'main/checks/tests'),
      completeNode('main/checks/scan'),
      expectNodeExecutions('main/checks/report'),
      completeNode('main/checks/report'),
      completeNode('main/checks/tests'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'fails an all join when one branch fails and drains the remainder',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'parallel',
          key: 'checks',
          branches: { security: task('security'), tests: task('tests') },
          join: {
            kind: 'all',
            successfulOutcomes: ['completed'],
            remaining: 'drain',
          },
        },
        { completed: end('succeeded'), failed: end('failed') },
      ),
      {
        bindings: [
          agentBinding('checks/security', 'security-reviewer'),
          agentBinding('checks/tests', 'test-runner'),
        ],
      },
    ),
    steps: [
      startRun(),
      failNode('main/checks/security', 'policy_violation'),
      expectRunStatus('running'),
      completeNode('main/checks/tests'),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'drains remaining branches after an any join succeeds',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'proposals',
          branches: { first: task('first'), second: task('second') },
          join: {
            kind: 'any',
            successfulOutcomes: ['completed'],
            remaining: 'drain',
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('proposals/first', 'developer'),
          agentBinding('proposals/second', 'developer'),
        ],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/proposals/first'),
      expectRunStatus('running'),
      completeNode('main/proposals/second'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'fails an any join after every branch fails',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'parallel',
          key: 'proposals',
          branches: { first: task('first'), second: task('second') },
          join: {
            kind: 'any',
            successfulOutcomes: ['completed'],
            remaining: 'drain',
          },
        },
        { completed: end('succeeded'), failed: end('failed') },
      ),
      {
        bindings: [
          agentBinding('proposals/first', 'developer'),
          agentBinding('proposals/second', 'developer'),
        ],
      },
    ),
    steps: [
      startRun(),
      failNode('main/proposals/first', 'proposal_failed'),
      failNode('main/proposals/second', 'proposal_failed'),
      expectEvent('parallel.joinFailed', { path: 'main/proposals' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'cancels remaining branches after a threshold join succeeds',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        {
          kind: 'parallel',
          key: 'review',
          branches: { a: task('a'), b: task('b'), c: task('c') },
          join: {
            kind: 'threshold',
            count: 2,
            successfulOutcomes: ['completed'],
            remaining: 'cancel',
          },
        },
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('review/a', 'reviewer'),
          agentBinding('review/b', 'reviewer'),
          agentBinding('review/c', 'reviewer'),
        ],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/review/a'),
      completeNode('main/review/b'),
      expectEvent('nodeExecution.cancelled', { path: 'main/review/c' }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'parallelExecution',
    name: 'fails a threshold join when the threshold becomes unreachable',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'parallel',
          key: 'review',
          branches: { a: task('a'), b: task('b'), c: task('c') },
          join: {
            kind: 'threshold',
            count: 2,
            successfulOutcomes: ['completed'],
            remaining: 'cancel',
          },
        },
        { completed: end('succeeded'), failed: end('failed') },
      ),
      {
        bindings: [
          agentBinding('review/a', 'reviewer'),
          agentBinding('review/b', 'reviewer'),
          agentBinding('review/c', 'reviewer'),
        ],
      },
    ),
    steps: [
      startRun(),
      failNode('main/review/a', 'review_failed'),
      failNode('main/review/b', 'review_failed'),
      expectEvent('nodeExecution.cancelled', { path: 'main/review/c' }),
      expectRunStatus('failed'),
    ],
  }),
];
