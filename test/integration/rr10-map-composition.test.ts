import { describe, expect, it } from 'vitest';

import {
  agentBinding,
  completeNode,
  end,
  executionPlan,
  expectNodeExecutions,
  expectNodeInput,
  expectRunStatus,
  fromMapItem,
  fromRunInput,
  scenario,
  sequence,
  startRun,
  task,
  type RunScenario,
} from '../dsl/run-scenario.js';
import { runAcceptanceScenario } from '../support/acceptance/run-acceptance-scenario.js';

const map = (
  body: RunScenario['plan']['pipelines'][string]['root'],
  options: {
    readonly key?: string;
    readonly items?: ReturnType<typeof fromRunInput> | ReturnType<typeof fromMapItem>;
  } = {},
) => ({
  kind: 'map' as const,
  key: options.key ?? 'repositories',
  items: options.items ?? fromRunInput('/repositories'),
  itemKeyPath: '/id',
  maximumItems: 10,
  concurrency: 2,
  failure: { kind: 'collect' as const },
  body,
});

const compositions: readonly RunScenario[] = [
  scenario({
    intentId: 'rr-068',
    category: 'map',
    name: 'composes a map item through a parallel body',
    requiredCapabilities: ['boundedMapExecution'],
    plan: executionPlan(
      sequence(
        map({
          kind: 'parallel',
          key: 'checks',
          branches: { a: task('a'), b: task('b') },
          join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
        }),
        end('succeeded'),
      ),
      {
        bindings: [
          agentBinding('repositories/checks/a', 'reviewer'),
          agentBinding('repositories/checks/b', 'reviewer'),
        ],
      },
    ),
    steps: [
      startRun({ repositories: [{ id: 'repo' }] }),
      expectNodeExecutions('main/repositories[repo]/checks/a', 'main/repositories[repo]/checks/b'),
      completeNode('main/repositories[repo]/checks/a'),
      completeNode('main/repositories[repo]/checks/b'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-068',
    category: 'map',
    name: 'composes a map item through a repeat body',
    requiredCapabilities: ['boundedMapExecution'],
    plan: executionPlan(
      sequence(
        map({
          kind: 'repeat',
          key: 'review',
          maximumIterations: 2,
          continueOn: ['retry'],
          completeOn: ['completed'],
          body: task('work', { input: { repository: fromMapItem('') } }),
        }),
        end('succeeded'),
      ),
      {
        bindings: [agentBinding('repositories/review/work', 'reviewer')],
      },
    ),
    steps: [
      startRun({ repositories: [{ id: 'repo' }] }),
      expectNodeExecutions('main/repositories[repo]/review[1]/work'),
      expectNodeInput('main/repositories[repo]/review[1]/work', {
        repository: { id: 'repo' },
      }),
      completeNode('main/repositories[repo]/review[1]/work'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-068',
    category: 'map',
    name: 'composes a map item through an inline subpipeline body',
    requiredCapabilities: ['boundedMapExecution'],
    plan: executionPlan(
      sequence(map({ kind: 'subpipeline', key: 'phase', pipelineId: 'child' }), end('succeeded')),
      {
        pipelines: {
          child: sequence(
            task('work', { input: { repository: fromMapItem('') } }),
            end('succeeded', { outcome: 'completed' }),
          ),
        },
        bindings: [agentBinding('work', 'reviewer', { pipelineId: 'child' })],
      },
    ),
    steps: [
      startRun({ repositories: [{ id: 'repo' }] }),
      expectNodeExecutions('main/repositories[repo]/phase/work'),
      expectNodeInput('main/repositories[repo]/phase/work', { repository: { id: 'repo' } }),
      completeNode('main/repositories[repo]/phase/work'),
      expectRunStatus('succeeded'),
    ],
  }),
  scenario({
    intentId: 'rr-068',
    category: 'map',
    name: 'shadows an outer map item in a nested map body',
    requiredCapabilities: ['boundedMapExecution'],
    plan: executionPlan(
      sequence(
        map(
          map(task('work', { input: { child: fromMapItem('') } }), {
            key: 'children',
            items: { kind: 'mapItem', path: '/children' },
          }),
        ),
        end('succeeded'),
      ),
      { bindings: [agentBinding('repositories/children/work', 'reviewer')] },
    ),
    steps: [
      startRun({ repositories: [{ id: 'repo', children: [{ id: 'child' }] }] }),
      expectNodeExecutions('main/repositories[repo]/children[child]/work'),
      expectNodeInput('main/repositories[repo]/children[child]/work', { child: { id: 'child' } }),
      completeNode('main/repositories[repo]/children[child]/work'),
      expectRunStatus('succeeded'),
    ],
  }),
];

describe.sequential('RR-10 map composition', () => {
  it.each(compositions)(
    '$name',
    async (composition) => {
      await expect(runAcceptanceScenario(composition)).resolves.toBeUndefined();
    },
    20_000,
  );
});
