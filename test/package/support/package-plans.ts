import type {
  ExecutionBinding,
  ExecutionPlan,
  ExecutionPolicies,
  PipelineNode,
} from '../../../src/index.js';

const policies: ExecutionPolicies = {
  defaultTaskTimeoutMs: 30_000,
  maximumActiveNodeExecutions: 10,
  maximumNodeNestingDepth: 10,
  maximumSubpipelineDepth: 10,
  maximumTotalNodeExecutions: 1_000,
};

const scriptBinding = (nodePath: string, pipelineId = 'main'): ExecutionBinding => ({
  kind: 'script',
  target: { pipelineId, nodePath },
  script: { id: 'package.quality', revision: 1 },
});

const plan = (
  root: PipelineNode,
  bindings: readonly ExecutionBinding[] = [],
  pipelines: Readonly<Record<string, PipelineNode>> = {},
): ExecutionPlan => ({
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: { root },
    ...Object.fromEntries(
      Object.entries(pipelines).map(([id, pipelineRoot]) => [id, { root: pipelineRoot }]),
    ),
  },
  bindings,
  policies,
});

const succeeded = (): PipelineNode => ({ kind: 'end', status: 'succeeded', outcome: 'completed' });
const failed = (outcome = 'failed'): PipelineNode => ({ kind: 'end', status: 'failed', outcome });

export const scriptTaskPlan = (): ExecutionPlan =>
  plan({ kind: 'sequence', children: [{ kind: 'task', key: 'work' }, succeeded()] }, [
    scriptBinding('work'),
  ]);

export const firstAnswerGatePlan = (): ExecutionPlan =>
  plan({
    kind: 'outcomeSwitch',
    source: {
      kind: 'humanGate',
      key: 'approval',
      answers: ['approved', 'rejected'],
      decision: { kind: 'firstAnswer' },
    },
    cases: {
      approved: succeeded(),
      rejected: failed('rejected'),
    },
  });

export const delayPlan = (): ExecutionPlan =>
  plan({
    kind: 'sequence',
    children: [{ kind: 'delay', key: 'cooldown', durationMs: 50 }, succeeded()],
  });

export const parallelPlan = (): ExecutionPlan =>
  plan(
    {
      kind: 'sequence',
      children: [
        {
          kind: 'parallel',
          key: 'checks',
          branches: {
            security: { kind: 'task', key: 'security' },
            tests: { kind: 'task', key: 'tests' },
          },
          join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
        },
        succeeded(),
      ],
    },
    [scriptBinding('checks/security'), scriptBinding('checks/tests')],
  );

export const branchPlan = (): ExecutionPlan =>
  plan(
    {
      kind: 'sequence',
      children: [
        { kind: 'task', key: 'classify' },
        {
          kind: 'branch',
          key: 'route',
          value: { kind: 'nodeOutput', nodePath: 'classify', outputKey: 'result', path: '/risk' },
          cases: {
            high: { kind: 'task', key: 'security-review' },
            low: succeeded(),
          },
          default: { kind: 'end', status: 'succeeded', outcome: 'manual-review' },
        },
        succeeded(),
      ],
    },
    [scriptBinding('classify'), scriptBinding('route/security-review')],
  );

export const mapPlan = (): ExecutionPlan =>
  plan(
    {
      kind: 'sequence',
      children: [
        {
          kind: 'map',
          key: 'items',
          items: { kind: 'runInput', path: '/items' },
          itemKeyPath: '/id',
          maximumItems: 10,
          concurrency: 2,
          failure: { kind: 'failFast', remaining: 'drain' },
          body: {
            kind: 'task',
            key: 'review',
            input: { item: { kind: 'mapItem', path: '' } },
          },
        },
        succeeded(),
      ],
    },
    [scriptBinding('items/review')],
  );

export const repeatPlan = (): ExecutionPlan =>
  plan(
    {
      kind: 'sequence',
      children: [
        {
          kind: 'repeat',
          key: 'cycle',
          maximumIterations: 2,
          continueOn: ['rejected'],
          completeOn: ['completed'],
          body: { kind: 'task', key: 'review' },
        },
        succeeded(),
      ],
    },
    [scriptBinding('cycle/review')],
  );

export const subpipelinePlan = (): ExecutionPlan =>
  plan(
    {
      kind: 'sequence',
      children: [{ kind: 'subpipeline', key: 'review', pipelineId: 'child' }, succeeded()],
    },
    [scriptBinding('work', 'child')],
    {
      child: {
        kind: 'sequence',
        children: [{ kind: 'task', key: 'work' }, succeeded()],
      },
    },
  );

export const consensusPlan = (): ExecutionPlan =>
  plan(
    {
      kind: 'outcomeSwitch',
      source: {
        kind: 'consensus',
        key: 'review',
        participants: {
          architecture: { kind: 'task', key: 'architecture' },
          security: { kind: 'task', key: 'security' },
        },
        policy: { kind: 'unanimous' },
        remaining: 'drain',
      },
      cases: {
        approved: succeeded(),
        rejected: failed('rejected'),
      },
    },
    [scriptBinding('review/architecture'), scriptBinding('review/security')],
  );

export const unknownOutcomePlan = (): ExecutionPlan =>
  plan(
    {
      kind: 'sequence',
      children: [
        {
          kind: 'task',
          key: 'work',
          recovery: {
            reconciliation: 'required',
            maximumAttempts: 2,
            timeoutMs: 30_000,
            unknownOutcome: 'requireHumanResolution',
          },
        },
        succeeded(),
      ],
    },
    [scriptBinding('work')],
  );
