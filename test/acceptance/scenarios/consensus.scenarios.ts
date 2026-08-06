import {
  agentBinding,
  end,
  executionPlan,
  expectEvent,
  expectNodeExecutions,
  expectRunStatus,
  failNode,
  routeOutcomes,
  scenario,
  startRun,
  task,
  vote,
  type RunScenario,
} from '../../dsl/run-scenario.js';

const consensusParticipants = {
  architecture: task('architecture'),
  security: task('security'),
} as const;

const consensusBindings = [
  agentBinding('review/architecture', 'architecture-reviewer'),
  agentBinding('review/security', 'security-reviewer'),
] as const;

export const consensusScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'consensus',
    name: 'approves a unanimous consensus after every participant approves',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'consensus',
          key: 'review',
          participants: consensusParticipants,
          policy: { kind: 'unanimous' },
          remaining: 'drain',
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
      { bindings: consensusBindings },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/review/architecture', 'main/review/security'),
      vote('main/review', 'architecture', 'approve', 'execution-architecture-1'),
      vote('main/review', 'security', 'approve', 'execution-security-1'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'consensus',
    name: 'rejects a unanimous consensus as soon as one participant rejects',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'consensus',
          key: 'review',
          participants: consensusParticipants,
          policy: { kind: 'unanimous' },
          remaining: 'cancel',
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
      { bindings: consensusBindings },
    ),
    steps: [
      startRun(),
      vote('main/review', 'security', 'reject', 'execution-security-1'),
      expectEvent('consensus.rejected', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'consensus',
    name: 'reports an insufficient quorum when too many participants abstain',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'consensus',
          key: 'review',
          participants: { a: task('a'), b: task('b'), c: task('c') },
          policy: { kind: 'quorum', count: 2 },
          remaining: 'drain',
        },
        { approved: end('succeeded'), insufficientQuorum: end('failed') },
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
      vote('main/review', 'a', 'approve', 'execution-a-1'),
      vote('main/review', 'b', 'abstain', 'execution-b-1'),
      vote('main/review', 'c', 'abstain', 'execution-c-1'),
      expectEvent('consensus.insufficientQuorum', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'consensus',
    name: 'applies independent approve and reject thresholds',
    blockedBy: 'pipelineContract',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'consensus',
          key: 'review',
          participants: { a: task('a'), b: task('b'), c: task('c') },
          policy: { kind: 'threshold', approve: 2, reject: 2 },
          remaining: 'cancel',
        },
        { approved: end('succeeded'), rejected: end('failed') },
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
      vote('main/review', 'a', 'approve', 'execution-a-1'),
      vote('main/review', 'b', 'approve', 'execution-b-1'),
      expectEvent('nodeExecution.cancelled', { path: 'main/review/c' }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'consensus',
    name: 'rejects duplicate and unknown participant votes',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'consensus',
          key: 'review',
          participants: consensusParticipants,
          policy: { kind: 'unanimous' },
          remaining: 'drain',
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
      { bindings: consensusBindings },
    ),
    steps: [
      startRun(),
      vote('main/review', 'architecture', 'approve', 'execution-architecture-1'),
      vote('main/review', 'architecture', 'reject', 'execution-architecture-2'),
      {
        kind: 'expectEvent',
        event: {
          type: 'consensus.duplicateParticipantResultRejected',
          path: 'main/review/architecture',
        },
      },
      vote('main/review', 'unknown', 'approve', 'execution-unknown-1'),
      {
        kind: 'expectEvent',
        event: { type: 'consensus.unknownParticipantRejected', path: 'main/review/unknown' },
      },
      expectRunStatus('running'),
    ],
  }),
  scenario({
    capability: 'consensus',
    name: 'fails consensus when a participant execution fails',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'consensus',
          key: 'review',
          participants: consensusParticipants,
          policy: { kind: 'unanimous' },
          remaining: 'cancel',
        },
        { approved: end('succeeded'), failed: end('failed') },
      ),
      { bindings: consensusBindings },
    ),
    steps: [
      startRun(),
      failNode('main/review/security', 'provider_unavailable'),
      expectEvent('consensus.participantFailed', { path: 'main/review/security' }),
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'consensus',
    name: 'routes consensus timeout without waiting forever',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'consensus',
          key: 'review',
          participants: consensusParticipants,
          policy: { kind: 'unanimous' },
          remaining: 'cancel',
          timeoutMs: 300_000,
        },
        { approved: end('succeeded'), timedOut: end('failed') },
      ),
      { bindings: consensusBindings },
    ),
    steps: [
      startRun(),
      { kind: 'advanceTime', durationMs: 300_000 },
      expectEvent('consensus.timedOut', { path: 'main/review' }),
      expectRunStatus('failed'),
    ],
  }),
];
