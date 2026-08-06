import {
  answerGate,
  end,
  executionPlan,
  expectEvent,
  expectRunStatus,
  routeOutcomes,
  scenario,
  startRun,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const humanGateScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'humanGate',
    name: 'continues after answering a human gate following a manager restart',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'firstAnswer' },
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
    ),
    steps: [
      startRun(),
      { kind: 'expectHumanGateWaiting', path: 'main/approval' },
      { kind: 'crashManager', moment: 'whileWaiting' },
      { kind: 'restartManager' },
      answerGate('main/approval', 'approved', 'alice', 'gate-answer-1'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'humanGate',
    name: 'accepts an idempotent gate command once and rejects a conflicting command',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'firstAnswer' },
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
    ),
    steps: [
      startRun(),
      answerGate('main/approval', 'approved', 'alice', 'gate-answer-same'),
      answerGate('main/approval', 'approved', 'alice', 'gate-answer-same'),
      answerGate('main/approval', 'rejected', 'alice', 'gate-answer-conflict'),
      {
        kind: 'expectCommandRejected',
        commandId: 'gate-answer-conflict',
        reason: 'gate_already_resolved',
      },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'humanGate',
    name: 'requires distinct authorized approvers for separation of duties',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'production-approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'matchingAnswers', count: 2, onConflict: 'conflict' },
          eligibleGroup: 'production-approvers',
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
    ),
    steps: [
      startRun(),
      answerGate('main/production-approval', 'approved', 'alice', 'approval-alice-1', [
        'production-approvers',
      ]),
      answerGate('main/production-approval', 'approved', 'alice', 'approval-alice-2', [
        'production-approvers',
      ]),
      {
        kind: 'expectCommandRejected',
        commandId: 'approval-alice-2',
        reason: 'actor_already_answered',
      },
      answerGate('main/production-approval', 'approved', 'bob', 'approval-bob-1', [
        'production-approvers',
      ]),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'humanGate',
    name: 'rejects an answer from an ineligible actor',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'production-approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'firstAnswer' },
          eligibleGroup: 'production-approvers',
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
    ),
    steps: [
      startRun(),
      answerGate('main/production-approval', 'approved', 'mallory', 'approval-mallory-1', [
        'developers',
      ]),
      {
        kind: 'expectCommandRejected',
        commandId: 'approval-mallory-1',
        reason: 'actor_not_eligible',
      },
      expectRunStatus('running'),
    ],
  }),
  scenario({
    capability: 'humanGate',
    name: 'routes conflicting multi-approver answers by an explicit gate policy',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'production-approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'matchingAnswers', count: 2, onConflict: 'conflict' },
          eligibleGroup: 'production-approvers',
        },
        {
          approved: end('succeeded'),
          rejected: end('failed'),
          conflict: end('succeeded', { outcome: 'manual-escalation' }),
        },
      ),
    ),
    steps: [
      startRun(),
      answerGate('main/production-approval', 'approved', 'alice', 'approval-alice-conflict', [
        'production-approvers',
      ]),
      answerGate('main/production-approval', 'rejected', 'bob', 'approval-bob-conflict', [
        'production-approvers',
      ]),
      expectEvent('humanGate.conflict', { path: 'main/production-approval' }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'humanGate',
    name: 'rejects an answer outside the gate answer vocabulary',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'firstAnswer' },
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
    ),
    steps: [
      startRun(),
      answerGate('main/approval', 'maybe', 'alice', 'gate-invalid-1'),
      {
        kind: 'expectCommandRejected',
        commandId: 'gate-invalid-1',
        reason: 'invalid_gate_answer',
      },
      expectRunStatus('running'),
    ],
  }),
  scenario({
    capability: 'humanGate',
    name: 'routes an unanswered human gate after its deadline',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'firstAnswer' },
          timeoutMs: 86_400_000,
        },
        {
          approved: end('succeeded'),
          rejected: end('failed'),
          timedOut: end('succeeded', { outcome: 'escalated' }),
        },
      ),
    ),
    steps: [
      startRun(),
      { kind: 'expectHumanGateWaiting', path: 'main/approval' },
      { kind: 'advanceTime', durationMs: 86_400_000 },
      expectEvent('humanGate.timedOut', { path: 'main/approval' }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'humanGate',
    name: 'cancels a run while it is waiting at a human gate',
    blockedBy: 'runManagerApi',
    plan: executionPlan(
      routeOutcomes(
        {
          kind: 'humanGate',
          key: 'approval',
          answers: ['approved', 'rejected'],
          decision: { kind: 'firstAnswer' },
        },
        { approved: end('succeeded'), rejected: end('failed') },
      ),
    ),
    steps: [
      startRun(),
      { kind: 'expectHumanGateWaiting', path: 'main/approval' },
      { kind: 'cancelRun', actorId: 'operator', commandId: 'cancel-gate-1' },
      expectEvent('humanGate.cancelled', { path: 'main/approval' }),
      expectRunStatus('cancelled'),
    ],
  }),
];
