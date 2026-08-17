import { describe, expect, it } from 'vitest';

import type { MapNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { MapItemResult } from '../../src/contracts/workflow/map-item-result.js';
import type { MapItemWorkflowInput } from '../../src/contracts/workflow/map-item-workflow-input.js';
import { mapControlDecisionStepName, mapItemWorkflowName } from '../../src/dbos/dbos-names.js';
import { buildObservablePlan } from '../../src/dbos/read-model/observable-plan.js';
import { RunMapObservationProjector } from '../../src/dbos/read-model/run-map-observation-projector.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import {
  createMapItemScopeId,
  createRootScopeId,
} from '../../src/pipeline/identity/execution-identity.js';
import { executionPlan, task } from '../dsl/pipeline-builder.js';
import { step, workflowStatus } from '../support/run-details.fixture.js';

const runId = 'Map_1';
const rawKeys = ['a]/x', '%41', '\ud800'];
const mapNode = (remaining: 'cancel' | 'drain' = 'cancel'): MapNode => ({
  kind: 'map',
  key: 'repositories',
  items: { kind: 'runInput', path: '/repositories' },
  itemKeyPath: '/id',
  maximumItems: 10,
  concurrency: 2,
  failure: { kind: 'failFast', remaining },
  body: task('review'),
});

const harness = (remaining: 'cancel' | 'drain' = 'cancel', authoritativeTerminal = true) => {
  const plan = buildObservablePlan(executionPlan(mapNode(remaining)), runId);
  const rootScopeId = createRootScopeId({ runId, rootPipelineId: 'main' });
  const root = plan.scopes.get(rootScopeId);
  const map = plan.mapNodesByDisplayPath.get('main/repositories');
  if (root?.kind !== 'root' || map === undefined) {
    throw new Error('Map observable plan fixture is incomplete.');
  }
  const inputs = new Map<string, MapItemWorkflowInput>();
  const add = (sourceIndex: number, itemKey: string, disposition: 'execute' | 'settlementOnly') => {
    const scopeId = createMapItemScopeId({
      parentScopeId: rootScopeId,
      authoredNodeId: map.authoredNodeId,
      itemKey,
    });
    const workflowId = scopeWorkflowId(scopeId);
    const input: MapItemWorkflowInput = {
      runId,
      scopeId,
      parentScopeId: rootScopeId,
      mapNodeInstanceId: map.nodeInstanceId,
      sourceIndex,
      itemKey,
      item: { id: itemKey },
      node: map.node.body,
      pipelineId: 'main',
      pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
      runtimePath: `main/repositories[${
        itemKey === 'a]/x' ? 'a%5D%2Fx' : itemKey === '%41' ? '%2541' : '%uD800'
      }]`,
      parentPath: 'repositories',
      inheritedOutputs: [],
      maximumParallelism: 2,
      parentWorkflowId: scopeWorkflowId(rootScopeId),
      disposition,
      startFence: {
        directive: 'start',
        requestId: `request:${workflowId}`,
        admissionId: `admission:${workflowId}`,
        workflowId,
      },
    };
    inputs.set(itemKey, input);
    return plan.addMapItem(input);
  };
  const projector = new RunMapObservationProjector(plan, authoritativeTerminal);
  return { add, inputs, map, plan, projector, root };
};

const observe = (
  subject: ReturnType<typeof harness>,
  candidate: ReturnType<ReturnType<typeof harness>['add']>,
  result: MapItemResult,
) => {
  const input = subject.inputs.get(candidate.mapIdentity.itemKey);
  if (input === undefined) {
    throw new Error('Missing map item input fixture.');
  }
  subject.projector.includeScopeStatus(
    workflowStatus(
      scopeWorkflowId(candidate.id),
      mapItemWorkflowName,
      input,
      input.parentWorkflowId,
      result,
    ),
    candidate,
  );
};

const decide = (subject: ReturnType<typeof harness>, output: unknown) => {
  subject.projector.includeScopeSteps(
    [step(1, mapControlDecisionStepName('main/repositories'), { output })],
    subject.root,
  );
};

describe('map read model', () => {
  it('materializes raw-key item scopes and body nodes with canonical display paths', () => {
    const subject = harness();
    const scopes = rawKeys.map((key, sourceIndex) => subject.add(sourceIndex, key, 'execute'));

    expect(scopes.map(({ displayPath }) => displayPath)).toEqual([
      'main/repositories[a%5D%2Fx]',
      'main/repositories[%2541]',
      'main/repositories[%uD800]',
    ]);
    expect(subject.plan.nodesByDisplayPath.has('main/repositories[a%5D%2Fx]/review')).toBe(true);
    expect(subject.plan.nodesByDisplayPath.has('main/repositories[%2541]/review')).toBe(true);
    expect(subject.plan.nodesByDisplayPath.has('main/repositories[%uD800]/review')).toBe(true);
  });

  it('publishes an all-settled aggregate only after its durable decision', () => {
    const subject = harness();
    const first = subject.add(0, 'a]/x', 'execute');
    const second = subject.add(1, '%41', 'execute');
    observe(subject, first, {
      kind: 'continued',
      sourceIndex: 0,
      itemKey: 'a]/x',
      outcome: 'completed',
    });
    observe(subject, second, {
      kind: 'continued',
      sourceIndex: 1,
      itemKey: '%41',
      outcome: 'failed',
    });

    subject.projector.finish();
    expect(subject.projector.observations).toEqual([]);

    const decided = harness();
    const decidedFirst = decided.add(0, 'a]/x', 'execute');
    const decidedSecond = decided.add(1, '%41', 'execute');
    observe(decided, decidedFirst, {
      kind: 'continued',
      sourceIndex: 0,
      itemKey: 'a]/x',
      outcome: 'completed',
    });
    observe(decided, decidedSecond, {
      kind: 'continued',
      sourceIndex: 1,
      itemKey: '%41',
      outcome: 'failed',
    });
    decide(decided, {
      scopeId: decided.map.scopeId,
      nodeInstanceId: decided.map.nodeInstanceId,
      control: 'allSettled',
      summaryEligibleItemKeys: ['a]/x', '%41'],
      admitted: [
        { sourceIndex: 0, itemKey: 'a]/x' },
        { sourceIndex: 1, itemKey: '%41' },
      ],
      remaining: [],
    });
    decided.projector.finish();
    expect(decided.projector.observations).toEqual([
      {
        scopeId: decided.map.scopeId,
        nodeInstanceId: decided.map.nodeInstanceId,
        outcome: 'completedWithErrors',
        summary: {
          totalItems: 2,
          completedItems: 1,
          failedItems: 1,
          failures: [{ itemKey: '%41', outcome: 'failed' }],
        },
      },
    ]);
  });

  it('projects cancel skips without materializing their durable scopes', () => {
    const subject = harness('cancel');
    const first = subject.add(0, 'a]/x', 'execute');
    observe(subject, first, {
      kind: 'continued',
      sourceIndex: 0,
      itemKey: 'a]/x',
      outcome: 'failed',
    });
    decide(subject, {
      scopeId: subject.map.scopeId,
      nodeInstanceId: subject.map.nodeInstanceId,
      control: 'failureDecided',
      decisiveItemKey: 'a]/x',
      summaryEligibleItemKeys: ['a]/x'],
      admitted: [{ sourceIndex: 0, itemKey: 'a]/x' }],
      remaining: [
        { sourceIndex: 1, itemKey: '%41', disposition: 'cancel' },
        { sourceIndex: 2, itemKey: '\ud800', disposition: 'cancel' },
      ],
    });
    subject.projector.finish();

    expect(subject.projector.observations[0]).toMatchObject({
      outcome: 'failed',
      remaining: 'cancel',
      decisiveItemKey: 'a]/x',
      summary: { totalItems: 3, completedItems: 0, failedItems: 1 },
    });
    expect(
      subject.projector.skippedItems.map(({ sourceIndex, itemKey }) => [sourceIndex, itemKey]),
    ).toEqual([
      [1, '%41'],
      [2, '\ud800'],
    ]);
    expect(subject.plan.scopes.size).toBe(2);
  });

  it('freezes a drain summary at the failure decision and requires settlement-only remainder', () => {
    const subject = harness('drain');
    const decisive = subject.add(0, 'a]/x', 'execute');
    const active = subject.add(1, '%41', 'execute');
    const remainder = subject.add(2, '\ud800', 'settlementOnly');
    observe(subject, decisive, {
      kind: 'continued',
      sourceIndex: 0,
      itemKey: 'a]/x',
      outcome: 'failed',
    });
    observe(subject, active, {
      kind: 'terminal',
      sourceIndex: 1,
      itemKey: '%41',
      result: { status: 'failed', outcome: 'invalid' },
    });
    observe(subject, remainder, { kind: 'settlementOnly', sourceIndex: 2, itemKey: '\ud800' });
    decide(subject, {
      scopeId: subject.map.scopeId,
      nodeInstanceId: subject.map.nodeInstanceId,
      control: 'failureDecided',
      decisiveItemKey: 'a]/x',
      summaryEligibleItemKeys: ['a]/x'],
      admitted: [
        { sourceIndex: 0, itemKey: 'a]/x' },
        { sourceIndex: 1, itemKey: '%41' },
      ],
      remaining: [{ sourceIndex: 2, itemKey: '\ud800', disposition: 'drain' }],
    });
    subject.projector.finish();

    expect(subject.projector.observations[0]).toMatchObject({
      outcome: 'failed',
      remaining: 'drain',
      summary: { totalItems: 3, completedItems: 0, failedItems: 1 },
    });
    expect(subject.projector.skippedItems).toEqual([]);
  });

  it('projects an in-flight failure decision before its active sibling settles', () => {
    const subject = harness('drain', false);
    const decisive = subject.add(0, 'a]/x', 'execute');
    subject.add(1, '%41', 'execute');
    subject.add(2, '\ud800', 'settlementOnly');
    observe(subject, decisive, {
      kind: 'continued',
      sourceIndex: 0,
      itemKey: 'a]/x',
      outcome: 'failed',
    });
    decide(subject, {
      scopeId: subject.map.scopeId,
      nodeInstanceId: subject.map.nodeInstanceId,
      control: 'failureDecided',
      decisiveItemKey: 'a]/x',
      summaryEligibleItemKeys: ['a]/x'],
      admitted: [
        { sourceIndex: 0, itemKey: 'a]/x' },
        { sourceIndex: 1, itemKey: '%41' },
      ],
      remaining: [{ sourceIndex: 2, itemKey: '\ud800', disposition: 'drain' }],
    });

    subject.projector.finish();

    expect(subject.projector.observations).toMatchObject([
      {
        outcome: 'failed',
        remaining: 'drain',
        decisiveItemKey: 'a]/x',
        summary: { totalItems: 3, completedItems: 0, failedItems: 1 },
      },
    ]);
  });
});
