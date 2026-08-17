import { describe, expect, it } from 'vitest';

import type { DurableParallelJoinDecision } from '../../src/contracts/workflow/parallel-join-decision.js';
import {
  parallelBranchWorkflowName,
  parallelJoinDecisionStepName,
} from '../../src/dbos/dbos-names.js';
import type { DbosStepRecord } from '../../src/dbos/read-model/dbos-step-pages.js';
import { mapParallelJoinObservation } from '../../src/dbos/read-model/map-parallel-join-observation.js';
import type { ObservableParallelCandidate } from '../../src/dbos/read-model/observable-plan.js';
import { buildObservablePlan } from '../../src/dbos/read-model/observable-plan.js';
import { RunParallelObservationProjector } from '../../src/dbos/read-model/run-parallel-observation-projector.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { end, executionPlan } from '../dsl/pipeline-builder.js';

const scopeId = `sc1_${'a'.repeat(43)}`;
const nodeInstanceId = `ni1_${'b'.repeat(43)}`;

const candidate: ObservableParallelCandidate = {
  node: {
    kind: 'parallel',
    key: 'review',
    branches: {
      first: { kind: 'end', status: 'succeeded', outcome: 'completed' },
      second: { kind: 'end', status: 'succeeded', outcome: 'completed' },
      third: { kind: 'end', status: 'succeeded', outcome: 'completed' },
    },
    join: {
      kind: 'threshold',
      count: 2,
      successfulOutcomes: ['completed'],
      remaining: 'cancel',
    },
  },
  nodeInstanceId,
  scopeId,
  physicalScopeId: scopeId,
  branchScopeIds: new Map([
    ['first', `sc1_${'c'.repeat(43)}`],
    ['second', `sc1_${'d'.repeat(43)}`],
    ['third', `sc1_${'e'.repeat(43)}`],
  ]),
};

const decision: DurableParallelJoinDecision = {
  kind: 'parallelJoinDecision',
  scopeId,
  nodeInstanceId,
  outcome: 'succeeded',
  remaining: 'cancel',
  settlements: [
    { key: 'second', outcome: 'completed' },
    { key: 'first', outcome: 'completed' },
  ],
  outputEligibleBranchKeys: ['first', 'second'],
  skippedBranchKeys: ['third'],
};

const observationStep = (
  functionID: number,
  name: string,
  values: Partial<DbosStepRecord> = {},
): DbosStepRecord => ({
  functionID,
  name,
  output: null,
  error: null,
  childWorkflowID: null,
  ...values,
});

const admissionReadFixture = (authoritativeTerminal: boolean) => {
  const observablePlan = buildObservablePlan(
    executionPlan({
      kind: 'parallel',
      key: 'review',
      branches: {
        first: end('succeeded'),
        second: end('succeeded'),
      },
      join: { kind: 'any', successfulOutcomes: ['completed'], remaining: 'drain' },
    }),
    'admission-read',
  );
  const parallel = observablePlan.parallelNodesByDisplayPath.get('main/review');
  if (parallel === undefined) {
    throw new Error('Admission read fixture has no parallel candidate.');
  }
  const physicalScope = observablePlan.scopes.get(parallel.physicalScopeId);
  if (physicalScope === undefined || physicalScope.kind === 'inlineSubpipeline') {
    throw new Error('Admission read fixture has no durable physical scope.');
  }
  const firstScopeId = parallel.branchScopeIds.get('first');
  if (firstScopeId === undefined) {
    throw new Error('Admission read fixture has no first branch scope.');
  }
  const workflowId = scopeWorkflowId(firstScopeId);
  const durableDecision: DurableParallelJoinDecision = {
    kind: 'parallelJoinDecision',
    scopeId: parallel.scopeId,
    nodeInstanceId: parallel.nodeInstanceId,
    outcome: 'succeeded',
    remaining: 'drain',
    settlements: [{ key: 'first', outcome: 'completed' }],
    outputEligibleBranchKeys: ['first'],
    skippedBranchKeys: [],
  };
  return {
    physicalScope,
    projector: new RunParallelObservationProjector(observablePlan, authoritativeTerminal),
    decisionStep: observationStep(2, parallelJoinDecisionStepName('main/review'), {
      output: durableDecision,
    }),
    admissionStep: observationStep(1, 'DBOS.recv', {
      output: {
        requestId: 'request:first',
        admissionId: 'admission:first',
        workflowId,
        directive: 'start',
      },
    }),
    startStep: observationStep(3, parallelBranchWorkflowName, { childWorkflowID: workflowId }),
  };
};

describe('parallel observation semantics', () => {
  it('accepts an admission acknowledgement before its child-start record in a running read', () => {
    const fixture = admissionReadFixture(false);

    fixture.projector.includeScopeSteps(
      [fixture.admissionStep, fixture.decisionStep],
      fixture.physicalScope,
    );

    expect(fixture.projector.observations).toMatchObject([
      { observedBranchKeys: ['first'], remaining: 'drain' },
    ]);
  });

  it('rejects an admission acknowledgement without its child-start record in a terminal read', () => {
    const fixture = admissionReadFixture(true);

    expect(() =>
      fixture.projector.includeScopeSteps(
        [fixture.admissionStep, fixture.decisionStep],
        fixture.physicalScope,
      ),
    ).toThrow('Parallel child admission and start records are inconsistent.');
  });

  it('rejects a child-start record without its admission acknowledgement in a running read', () => {
    const fixture = admissionReadFixture(false);

    expect(() =>
      fixture.projector.includeScopeSteps(
        [fixture.decisionStep, fixture.startStep],
        fixture.physicalScope,
      ),
    ).toThrow('Parallel child admission and start records are inconsistent.');
  });

  it('sorts joins lexicographically by scope and node while retaining authored skipped order', () => {
    const projector = new RunParallelObservationProjector(
      buildObservablePlan(executionPlan(end('succeeded')), 'ordering-run'),
      true,
    );
    const alphaScopeId = `sc1_${'a'.repeat(43)}`;
    const zetaScopeId = `sc1_${'z'.repeat(43)}`;
    const alphaNodeId = `ni1_${'a'.repeat(43)}`;
    const zetaNodeId = `ni1_${'z'.repeat(43)}`;
    projector.observations.push(
      {
        scopeId: zetaScopeId,
        nodeInstanceId: zetaNodeId,
        outcome: 'succeeded',
        remaining: 'cancel',
        observedBranchKeys: ['winner'],
        outputEligibleBranchKeys: ['winner'],
        skippedBranchKeys: ['zebra', 'alpha'],
      },
      {
        scopeId: alphaScopeId,
        nodeInstanceId: alphaNodeId,
        outcome: 'succeeded',
        remaining: 'cancel',
        observedBranchKeys: ['winner'],
        outputEligibleBranchKeys: ['winner'],
        skippedBranchKeys: ['middle'],
      },
    );
    projector.skippedBranches.push(
      {
        kind: 'parallelBranch',
        disposition: 'skipped',
        reason: 'join-decided',
        scopeId: `sc1_${'x'.repeat(43)}`,
        parentScopeId: zetaScopeId,
        nodeInstanceId: zetaNodeId,
        branchKey: 'zebra',
      },
      {
        kind: 'parallelBranch',
        disposition: 'skipped',
        reason: 'join-decided',
        scopeId: `sc1_${'y'.repeat(43)}`,
        parentScopeId: zetaScopeId,
        nodeInstanceId: zetaNodeId,
        branchKey: 'alpha',
      },
      {
        kind: 'parallelBranch',
        disposition: 'skipped',
        reason: 'join-decided',
        scopeId: `sc1_${'w'.repeat(43)}`,
        parentScopeId: alphaScopeId,
        nodeInstanceId: alphaNodeId,
        branchKey: 'middle',
      },
    );

    projector.finish();

    expect(projector.observations.map(({ scopeId: id }) => id)).toEqual([
      alphaScopeId,
      zetaScopeId,
    ]);
    expect(projector.skippedBranches.map(({ branchKey }) => branchKey)).toEqual([
      'middle',
      'zebra',
      'alpha',
    ]);
  });

  it('preserves settlement order while projecting eligible and skipped branches in authored order', () => {
    expect(mapParallelJoinObservation(candidate, decision, new Set(['first', 'second']))).toEqual({
      observation: {
        scopeId,
        nodeInstanceId,
        outcome: 'succeeded',
        remaining: 'cancel',
        observedBranchKeys: ['second', 'first'],
        outputEligibleBranchKeys: ['first', 'second'],
        skippedBranchKeys: ['third'],
      },
      skippedBranches: [
        {
          kind: 'parallelBranch',
          disposition: 'skipped',
          reason: 'join-decided',
          scopeId: `sc1_${'e'.repeat(43)}`,
          parentScopeId: scopeId,
          nodeInstanceId,
          branchKey: 'third',
        },
      ],
    });
  });

  it.each<{
    readonly name: string;
    readonly value: DurableParallelJoinDecision;
    readonly admitted: ReadonlySet<string>;
  }>([
    {
      name: 'foreign identity',
      value: { ...decision, scopeId: `sc1_${'f'.repeat(43)}` },
      admitted: new Set(['first', 'second']),
    },
    {
      name: 'duplicate settlement',
      value: {
        ...decision,
        settlements: [...decision.settlements, { key: 'second', outcome: 'completed' }],
      },
      admitted: new Set(['first', 'second']),
    },
    {
      name: 'reordered output eligibility',
      value: { ...decision, outputEligibleBranchKeys: ['second', 'first'] },
      admitted: new Set(['first', 'second']),
    },
    {
      name: 'threshold wrong outcome',
      value: { ...decision, outcome: 'failed' },
      admitted: new Set(['first', 'second']),
    },
    {
      name: 'missing skipped branch',
      value: { ...decision, skippedBranchKeys: [] },
      admitted: new Set(['first', 'second']),
    },
    {
      name: 'late post-decision settlement',
      value: {
        ...decision,
        settlements: [...decision.settlements, { key: 'third', outcome: 'completed' }],
      },
      admitted: new Set(['first', 'second', 'third']),
    },
    {
      name: 'admitted branch marked skipped',
      value: decision,
      admitted: new Set(['first', 'second', 'third']),
    },
    {
      name: 'foreign settlement',
      value: { ...decision, settlements: [{ key: 'foreign', outcome: 'completed' }] },
      admitted: new Set(['first', 'second']),
    },
  ])('rejects $name', ({ value, admitted }) => {
    expect(() => mapParallelJoinObservation(candidate, value, admitted)).toThrow(
      /Parallel join decision|not authored/,
    );
  });

  it('reads a transient drain decision before every settlement-only branch is admitted', () => {
    const drainCandidate: ObservableParallelCandidate = {
      ...candidate,
      node: {
        ...candidate.node,
        join: { ...candidate.node.join, remaining: 'drain' },
      },
    };
    expect(
      mapParallelJoinObservation(
        drainCandidate,
        { ...decision, remaining: 'drain', skippedBranchKeys: [] },
        new Set(['first', 'second']),
        false,
      ),
    ).toMatchObject({ observation: { remaining: 'drain', skippedBranchKeys: [] } });
  });

  it('requires every drain branch to be admitted after the terminal settlement barrier', () => {
    const drainCandidate: ObservableParallelCandidate = {
      ...candidate,
      node: {
        ...candidate.node,
        join: { ...candidate.node.join, remaining: 'drain' },
      },
    };
    expect(() =>
      mapParallelJoinObservation(
        drainCandidate,
        { ...decision, remaining: 'drain', skippedBranchKeys: [] },
        new Set(['first', 'second']),
        true,
      ),
    ).toThrow('semantics are invalid');
  });

  it('keeps multiple skipped branches in authored order even when keys are nonalphabetical', () => {
    const nonalphabetical: ObservableParallelCandidate = {
      ...candidate,
      node: {
        ...candidate.node,
        branches: {
          zebra: { kind: 'end', status: 'succeeded', outcome: 'completed' },
          alpha: { kind: 'end', status: 'succeeded', outcome: 'completed' },
          middle: { kind: 'end', status: 'succeeded', outcome: 'completed' },
        },
        join: { kind: 'any', successfulOutcomes: ['completed'], remaining: 'cancel' },
      },
      branchScopeIds: new Map([
        ['zebra', `sc1_${'c'.repeat(43)}`],
        ['alpha', `sc1_${'d'.repeat(43)}`],
        ['middle', `sc1_${'e'.repeat(43)}`],
      ]),
    };
    const projection = mapParallelJoinObservation(
      nonalphabetical,
      {
        ...decision,
        settlements: [{ key: 'alpha', outcome: 'completed' }],
        outputEligibleBranchKeys: ['alpha'],
        skippedBranchKeys: ['zebra', 'middle'],
      },
      new Set(['alpha']),
    );

    expect(projection.observation.skippedBranchKeys).toEqual(['zebra', 'middle']);
    expect(projection.skippedBranches.map(({ branchKey }) => branchKey)).toEqual([
      'zebra',
      'middle',
    ]);
  });
});
