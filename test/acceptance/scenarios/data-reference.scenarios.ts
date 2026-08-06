import {
  agentBinding,
  artifact,
  completeNode,
  completeNodeWithOutput,
  end,
  entity,
  executionPlan,
  expectEvent,
  expectNodeInput,
  expectNodeExecutions,
  expectOutputValue,
  expectRunStatus,
  fromNodeOutput,
  output,
  routeOutcomes,
  scenario,
  scriptBinding,
  secret,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../../dsl/run-scenario.js';

export const dataReferenceScenarios: readonly RunScenario[] = [
  scenario({
    capability: 'dataFlow',
    name: 'passes a versioned entity reference without embedding entity data in the plan',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        task('analyze', {
          input: {
            project: entity({ entityType: 'project', id: 'project-1', version: '17' }),
          },
        }),
        end('succeeded'),
      ),
      { bindings: [agentBinding('analyze', 'analyst')] },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/analyze'),
      completeNode('main/analyze'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'passes a durable artifact reference between node executions',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        task('implement'),
        task('publish', {
          input: { artifact: fromNodeOutput('implement', undefined, 'artifact') },
        }),
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('implement', 'developer'),
          scriptBinding('publish', 'artifact.publish'),
        ],
      },
    ),
    steps: [
      startRun(),
      completeNodeWithOutput(
        'main/implement',
        'completed',
        output({
          artifact: {
            kind: 'artifact',
            reference: {
              id: 'artifact-1',
              digest: 'sha256:example',
              mediaType: 'application/zip',
              size: 1_024,
            },
          },
        }),
      ),
      expectNodeExecutions('main/publish'),
      completeNode('main/publish'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'resolves a secret only at the executor boundary and never persists its value',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        task('deploy', { input: { credential: secret({ name: 'production-token' }) } }),
        end('succeeded'),
      ),
      { bindings: [scriptBinding('deploy', 'deployment.create')] },
    ),
    steps: [
      startRun(),
      completeNode('main/deploy'),
      { kind: 'expectSecretAbsent', value: 'resolved-production-token' },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'keeps reference-shaped executor JSON inert',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        task('produce'),
        task('consume', { input: { payload: fromNodeOutput('produce') } }),
        end('succeeded'),
      ),
      {
        bindings: [agentBinding('produce', 'producer'), agentBinding('consume', 'consumer')],
      },
    ),
    steps: [
      startRun(),
      completeNode('main/produce', 'completed', {
        artifactLike: {
          kind: 'artifact',
          reference: { id: 'untrusted-artifact' },
        },
        secretLike: {
          kind: 'secret',
          reference: { name: 'production-token' },
        },
      }),
      expectNodeInput('main/consume', {
        payload: {
          artifactLike: {
            kind: 'artifact',
            reference: { id: 'untrusted-artifact' },
          },
          secretLike: {
            kind: 'secret',
            reference: { name: 'production-token' },
          },
        },
      }),
      completeNode('main/consume'),
      { kind: 'expectSecretAbsent', value: 'resolved-production-token' },
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'fails a task safely when a referenced secret cannot be resolved',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(task('deploy', { input: { credential: secret({ name: 'missing-token' }) } }), {
        completed: end('succeeded'),
        failed: end('failed'),
      }),
      { bindings: [scriptBinding('deploy', 'deployment.create')] },
    ),
    steps: [
      startRun(),
      { kind: 'failInputResolution', path: 'main/deploy', errorCode: 'secret_not_found' },
      expectEvent('inputResolution.failed', { path: 'main/deploy' }),
      { kind: 'expectNoNodeExecution', path: 'main/deploy' },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'fails deterministically when a pinned entity version is unavailable',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      routeOutcomes(
        task('analyze', {
          input: {
            project: entity({ entityType: 'project', id: 'project-1', version: 'missing' }),
          },
        }),
        { completed: end('succeeded'), failed: end('failed') },
      ),
      { bindings: [agentBinding('analyze', 'analyst')] },
    ),
    steps: [
      startRun(),
      {
        kind: 'failInputResolution',
        path: 'main/analyze',
        errorCode: 'entity_version_not_found',
      },
      expectEvent('inputResolution.failed', { path: 'main/analyze' }),
      { kind: 'expectNoNodeExecution', path: 'main/analyze' },
      expectRunStatus('failed'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'stores a large node result as an artifact reference',
    blockedBy: 'runRuntime',
    plan: executionPlan(sequence(task('analyze'), end('succeeded')), {
      bindings: [agentBinding('analyze', 'analyst')],
    }),
    steps: [
      startRun(),
      completeNodeWithOutput(
        'main/analyze',
        'completed',
        output({
          report: {
            kind: 'artifact',
            reference: {
              id: 'report-1',
              digest: 'sha256:report',
              mediaType: 'application/json',
              size: 5_000_000,
            },
          },
        }),
      ),
      expectOutputValue('main/analyze', 'report', {
        kind: 'artifact',
        reference: {
          id: 'report-1',
          digest: 'sha256:report',
          mediaType: 'application/json',
          size: 5_000_000,
        },
      }),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    capability: 'dataFlow',
    name: 'uses an explicitly pinned artifact as task input',
    blockedBy: 'runRuntime',
    plan: executionPlan(
      sequence(
        task('inspect', {
          input: {
            archive: artifact({
              id: 'artifact-7',
              digest: 'sha256:archive',
              mediaType: 'application/zip',
              size: 2_048,
            }),
          },
        }),
        end('succeeded'),
      ),
      { bindings: [agentBinding('inspect', 'analyst')] },
    ),
    steps: [
      startRun(),
      expectNodeExecutions('main/inspect'),
      completeNode('main/inspect'),
      expectRunStatus('succeeded'),
    ],
  }),
];
