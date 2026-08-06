import {
  agentBinding,
  end,
  executionPlan,
  expectEvent,
  expectRunStatus,
  fromRunInput,
  scenario,
  scriptBinding,
  sequence,
  startRun,
  startRunWithPlanSchemaVersion,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const validationScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'validation',
    name: 'rejects an unsupported execution plan schema version',
    blockedBy: 'runManagerApi',
    plan: executionPlan(end('succeeded')),
    steps: [
      startRunWithPlanSchemaVersion(2),
      { kind: 'expectPlanRejected', errorCode: 'unsupported_plan_schema_version' },
    ],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects an execution plan whose root pipeline is missing',
    blockedBy: 'runManagerApi',
    plan: {
      ...executionPlan(end('succeeded')),
      rootPipelineId: 'missing',
    },
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'root_pipeline_not_found' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects a task without exactly one executor binding',
    blockedBy: 'pipelineContract',
    plan: executionPlan(task('work')),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'missing_executor_binding' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects duplicate executor bindings for one task',
    blockedBy: 'pipelineContract',
    plan: executionPlan(task('work'), {
      bindings: [agentBinding('work', 'developer'), scriptBinding('work', 'work.execute')],
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'duplicate_executor_binding' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects a plan whose repeat bound exceeds the total execution bound',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      {
        kind: 'repeat',
        key: 'work',
        maximumIterations: 11,
        continueOn: ['retry'],
        completeOn: ['completed'],
        body: task('attempt'),
      },
      {
        bindings: [agentBinding('work/attempt', 'developer')],
        policies: { maximumTotalNodeExecutions: 10 },
      },
    ),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'execution_bound_exceeded' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects a branch without a required default route',
    blockedBy: 'pipelineContract',
    plan: executionPlan({
      kind: 'branch',
      key: 'route',
      value: fromRunInput('/risk'),
      cases: { low: end('succeeded') },
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'missing_branch_default' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects an executor binding that targets a missing node path',
    blockedBy: 'pipelineContract',
    plan: executionPlan(end('succeeded'), {
      bindings: [agentBinding('missing', 'developer')],
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'binding_target_not_found' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects an executor binding that targets a control node',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      sequence({ kind: 'delay', key: 'cooldown', durationMs: 1_000 }, end('succeeded')),
      {
        bindings: [agentBinding('cooldown', 'developer')],
      },
    ),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'binding_target_not_task' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects duplicate sibling node keys',
    blockedBy: 'pipelineContract',
    plan: executionPlan(sequence(task('work'), task('work'), end('succeeded')), {
      bindings: [agentBinding('work', 'developer')],
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'duplicate_node_key' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects duplicate addressable keys across parallel branches',
    blockedBy: 'pipelineContract',
    plan: executionPlan({
      kind: 'parallel',
      key: 'checks',
      branches: {
        security: task('work'),
        tests: sequence(task('work'), end('succeeded')),
      },
      join: {
        kind: 'all',
        successfulOutcomes: ['completed'],
        remaining: 'drain',
      },
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'duplicate_node_key' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects reserved characters in a node key',
    blockedBy: 'pipelineContract',
    plan: executionPlan(task('invalid/key'), {
      bindings: [agentBinding('invalid/key', 'developer')],
    }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'invalid_node_key' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects reserved characters in the root pipeline id',
    blockedBy: 'pipelineContract',
    plan: executionPlan(end('succeeded'), { rootPipelineId: 'invalid/root' }),
    steps: [startRun(), { kind: 'expectPlanRejected', errorCode: 'invalid_pipeline_id' }],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects duplicate runtime map item keys',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      {
        kind: 'map',
        key: 'repositories',
        items: fromRunInput('/repositories'),
        itemKeyPath: '/id',
        maximumItems: 10,
        concurrency: 2,
        failure: { kind: 'failFast', remaining: 'cancel' },
        body: task('review'),
      },
      { bindings: [agentBinding('repositories/review', 'reviewer')] },
    ),
    steps: [
      startRun({ repositories: [{ id: 'same' }, { id: 'same' }] }),
      expectEvent('pipeline.invalidState', { path: 'main/repositories' }),
      { kind: 'expectNoNodeExecution', path: 'main/repositories[*]/review' },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects an unreachable consensus threshold',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      {
        kind: 'consensus',
        key: 'review',
        participants: { a: task('a'), b: task('b') },
        policy: { kind: 'threshold', approve: 3, reject: 2 },
        remaining: 'cancel',
      },
      {
        bindings: [agentBinding('review/a', 'reviewer'), agentBinding('review/b', 'reviewer')],
      },
    ),
    steps: [
      startRun(),
      { kind: 'expectPlanRejected', errorCode: 'unreachable_consensus_threshold' },
    ],
  }),
  scenario({
    capability: 'validation',
    name: 'rejects a composed map and repeat bound above the total execution limit',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      {
        kind: 'map',
        key: 'repositories',
        items: fromRunInput('/repositories'),
        itemKeyPath: '/id',
        maximumItems: 3,
        concurrency: 2,
        failure: { kind: 'collect' },
        body: {
          kind: 'repeat',
          key: 'review',
          maximumIterations: 2,
          continueOn: ['retry'],
          completeOn: ['completed'],
          body: task('attempt'),
        },
      },
      {
        bindings: [agentBinding('repositories/review/attempt', 'reviewer')],
        policies: { maximumTotalNodeExecutions: 5 },
      },
    ),
    steps: [
      startRun({ repositories: [{ id: 'a' }] }),
      { kind: 'expectPlanRejected', errorCode: 'execution_bound_exceeded' },
    ],
  }),
];
