import { describe, expect, it } from 'vitest';

import type { MapNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { DurableMapControlDecision } from '../../src/contracts/workflow/map-control-decision.js';
import { mapControlDecisionStepName } from '../../src/dbos/dbos-names.js';
import { buildObservablePlan } from '../../src/dbos/read-model/observable-plan.js';
import { RunMapObservationProjector } from '../../src/dbos/read-model/run-map-observation-projector.js';
import { executionPlan, task } from '../dsl/pipeline-builder.js';
import { step } from '../support/run-details.fixture.js';

type FailureDecision = Extract<DurableMapControlDecision, { readonly control: 'failureDecided' }>;

const mapNode: MapNode = {
  kind: 'map',
  key: 'repositories',
  items: { kind: 'runInput', path: '/repositories' },
  itemKeyPath: '/id',
  maximumItems: 10,
  concurrency: 2,
  failure: { kind: 'failFast', remaining: 'cancel' },
  body: task('review'),
};

const harness = () => {
  const plan = buildObservablePlan(executionPlan(mapNode), 'Map_validation');
  const map = plan.mapNodesByDisplayPath.get('main/repositories');
  if (map === undefined) {
    throw new Error('Map decision validation fixture is incomplete.');
  }
  const physicalScope = plan.scopes.get(map.physicalScopeId);
  if (physicalScope === undefined || physicalScope.kind === 'inlineSubpipeline') {
    throw new Error('Map decision validation fixture has no durable scope.');
  }
  return {
    map,
    physicalScope,
    projector: new RunMapObservationProjector(plan, true),
  };
};

const validDecision = (subject: ReturnType<typeof harness>): FailureDecision => ({
  scopeId: subject.map.scopeId,
  nodeInstanceId: subject.map.nodeInstanceId,
  control: 'failureDecided',
  decisiveItemKey: 'a',
  summaryEligibleItemKeys: ['a', 'b'],
  admitted: [
    { sourceIndex: 0, itemKey: 'a' },
    { sourceIndex: 1, itemKey: 'b' },
  ],
  remaining: [
    { sourceIndex: 2, itemKey: 'c', disposition: 'cancel' },
    { sourceIndex: 3, itemKey: 'd', disposition: 'cancel' },
  ],
});

const malformedOrders: readonly {
  readonly name: string;
  readonly mutate: (decision: FailureDecision) => FailureDecision;
}[] = [
  {
    name: 'descending admitted indexes',
    mutate: (decision) => ({ ...decision, admitted: [...decision.admitted].reverse() }),
  },
  {
    name: 'descending remaining indexes',
    mutate: (decision) => ({ ...decision, remaining: [...decision.remaining].reverse() }),
  },
  {
    name: 'reversed summary eligibility',
    mutate: (decision) => ({ ...decision, summaryEligibleItemKeys: ['b', 'a'] }),
  },
];

describe('RR-10 map read-model validation', () => {
  it('requires the complete decided child set for an authoritative terminal read', () => {
    const subject = harness();
    subject.projector.includeScopeSteps(
      [
        step(1, mapControlDecisionStepName('main/repositories'), {
          output: validDecision(subject),
        }),
      ],
      subject.physicalScope,
    );

    expect(() => subject.projector.finish()).toThrow(
      'Map child scopes do not match the durable control decision.',
    );
  });

  it.each(malformedOrders)('rejects $name', ({ mutate }) => {
    const subject = harness();
    subject.projector.includeScopeSteps(
      [
        step(1, mapControlDecisionStepName('main/repositories'), {
          output: mutate(validDecision(subject)),
        }),
      ],
      subject.physicalScope,
    );

    expect(() => subject.projector.finish()).toThrow('Map control decision semantics are invalid.');
  });
});
