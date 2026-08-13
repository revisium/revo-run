import {
  advanceTime,
  answerGate,
  end,
  executionPlan,
  expectCommandRejected,
  expectEvent,
  expectRunStatus,
  routeOutcomes,
  scenario,
  startRun,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const humanGateScenarios: readonly RunScenario[] = [
  scenario({
    intentId: 'rr-043',
    category: 'humanGate',
    name: 'continues after answering a human gate following a manager restart',
    requiredCapabilities: ['humanGateRecovery', 'managerRestartRecovery'],
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
    intentId: 'rr-044',
    category: 'humanGate',
    name: 'accepts an idempotent gate command once and rejects a conflicting command',
    requiredCapabilities: ['humanGateCommandIdempotency', 'commandRejection'],
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
      expectCommandRejected('gate_already_resolved', 'gate-answer-conflict'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-045',
    category: 'humanGate',
    name: 'requires distinct authorized approvers for separation of duties',
    requiredCapabilities: ['separationOfDuties', 'commandRejection'],
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
      expectCommandRejected('actor_already_answered', 'approval-alice-2'),
      answerGate('main/production-approval', 'approved', 'bob', 'approval-bob-1', [
        'production-approvers',
      ]),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-046',
    category: 'humanGate',
    name: 'rejects an answer from an ineligible actor',
    requiredCapabilities: ['humanGateAuthorization', 'commandRejection'],
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
      expectCommandRejected('actor_not_eligible', 'approval-mallory-1'),
      expectRunStatus('running'),
    ],
  }),
  scenario({
    intentId: 'rr-047',
    category: 'humanGate',
    name: 'routes conflicting multi-approver answers by an explicit gate policy',
    requiredCapabilities: ['humanGateConflictPolicy'],
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
    intentId: 'rr-048',
    category: 'humanGate',
    name: 'rejects an answer outside the gate answer vocabulary',
    requiredCapabilities: ['humanGateAnswerValidation', 'commandRejection'],
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
      expectCommandRejected('invalid_gate_answer', 'gate-invalid-1'),
      expectRunStatus('running'),
    ],
  }),
  scenario({
    intentId: 'rr-049',
    category: 'humanGate',
    name: 'routes an unanswered human gate after its deadline',
    requiredCapabilities: ['humanGateDeadlineRouting', 'dbosSafeTimeAdvancement'],
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
      advanceTime(86_400_000),
      expectEvent('humanGate.timedOut', { path: 'main/approval' }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-050',
    category: 'humanGate',
    name: 'cancels a run while it is waiting at a human gate',
    requiredCapabilities: ['humanGateCancellation'],
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
      { kind: 'cancelRun', actorId: 'operator' },
      expectEvent('humanGate.cancelled', { path: 'main/approval' }),
      expectRunStatus('cancelled'),
    ],
  }),
];
