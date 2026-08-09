import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectEvent,
  expectNodeExecutions,
  expectRunStatus,
  failNode,
  fromNodeOutput,
  routeOutcomes,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../../dsl/run-scenario.js';

export const parallelJoinScenarios: readonly RunScenario[] = [
  scenario({
    intentId: 'rr-025',
    category: 'parallelExecution',
    name: 'waits for every successful branch at an all join',
    requiredCapabilities: ['parallelAllJoin'],
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
    intentId: 'rr-026',
    category: 'parallelExecution',
    name: 'runs a multi-step pipeline as one parallel branch',
    requiredCapabilities: ['parallelBranchComposition'],
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
    intentId: 'rr-027',
    category: 'parallelExecution',
    name: 'fails an all join when one branch fails and drains the remainder',
    requiredCapabilities: ['parallelAllJoinFailure', 'parallelBranchDrain'],
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
    intentId: 'rr-028',
    category: 'parallelExecution',
    name: 'drains remaining branches after an any join succeeds',
    requiredCapabilities: ['parallelAnyJoin', 'parallelBranchDrain'],
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
    intentId: 'rr-029',
    category: 'parallelExecution',
    name: 'fails an any join after every branch fails',
    requiredCapabilities: ['parallelAnyJoinFailure'],
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
    intentId: 'rr-030',
    category: 'parallelExecution',
    name: 'drains every branch before completing a threshold join',
    requiredCapabilities: ['parallelThresholdJoin', 'parallelBranchDrain'],
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
            remaining: 'drain',
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
      expectRunStatus('running'),
      failNode('main/review/c', 'review_failed'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-031',
    category: 'dataFlow',
    name: 'publishes a branch input failure through the run event stream',
    requiredCapabilities: ['parallelInputFailure'],
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'parallel',
          key: 'work',
          branches: {
            invalid: task('invalid', {
              input: { missing: fromNodeOutput('missing') },
            }),
            valid: task('valid'),
          },
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
          agentBinding('work/invalid', 'developer'),
          agentBinding('work/valid', 'developer'),
        ],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/work/valid'),
      {
        kind: 'failInputResolution',
        path: 'main/work/invalid',
        errorCode: 'node_output_not_found',
      },
      expectRunStatus('failed'),
    ],
  }),
];
