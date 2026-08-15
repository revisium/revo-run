import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import type { ParallelJoinPolicy } from '../../src/contracts/pipeline/pipeline-node.js';
import { RunEventSchema } from '../../src/contracts/run/run-event.js';
import { ParallelBranchWorkflowInputSchema } from '../../src/contracts/workflow/parallel-branch-workflow-input.js';
import { DurableParallelJoinDecisionSchema } from '../../src/contracts/workflow/parallel-join-decision.js';
import { ScopeStartFenceReplySchema } from '../../src/contracts/workflow/run-coordinator-message.js';
import { ParallelJoinObservationSchema, SkippedParallelBranchSchema } from '../../src/index.js';
import type { ParallelBranchResult } from '../../src/pipeline/parallel/parallel-branch-runner.js';
import {
  eligibleParallelResults,
  initialParallelJoinState,
  settleParallelBranch,
} from '../../src/pipeline/parallel/parallel-join-reducer.js';
import matrixJson from '../fixtures/rr08/scopes-parallel-context-matrix.json' with { type: 'json' };
import goldenJson from '../fixtures/rr08/scopes-parallel-golden-vectors.json' with { type: 'json' };

interface Metadata {
  readonly artifactVersion: number;
  readonly cloudRevision: string;
  readonly contract: string;
  readonly sourceRevision: string;
}

const fixturePath = (name: string): URL => new URL(`../fixtures/rr08/${name}`, import.meta.url);
const digest = (name: string): string =>
  createHash('sha256')
    .update(readFileSync(fixturePath(name)))
    .digest('hex');

const goldenName = 'scopes-parallel-golden-vectors.json';
const matrixName = 'scopes-parallel-context-matrix.json';
const metadata: Metadata = {
  contract: 'rr-08-scopes-parallel',
  artifactVersion: 1,
  cloudRevision: 'Xx-qwSEgx953UpLTLlTjo',
  sourceRevision: 'a959aa4203fb6bc66e642aa8c054f3c689c8f141',
};

const parallelJoinValidator = Schema.Compile(ParallelJoinObservationSchema);
const skippedBranchValidator = Schema.Compile(SkippedParallelBranchSchema);
const runEventValidator = Schema.Compile(RunEventSchema);
const joinDecisionValidator = Schema.Compile(DurableParallelJoinDecisionSchema);
const admissionReplyValidator = Schema.Compile(ScopeStartFenceReplySchema);
const branchInputValidator = Schema.Compile(ParallelBranchWorkflowInputSchema);

const publicValidator = (schema: string): { Check(value: unknown): boolean } => {
  switch (schema) {
    case 'parallelJoin':
      return parallelJoinValidator;
    case 'skippedBranch':
      return skippedBranchValidator;
    case 'runEvent':
      return runEventValidator;
    default:
      throw new Error(`Unknown RR-08 public assurance schema ${schema}.`);
  }
};

const durableValidator = (schema: string): { Check(value: unknown): boolean } => {
  switch (schema) {
    case 'joinDecision':
      return joinDecisionValidator;
    case 'admissionReply':
      return admissionReplyValidator;
    case 'branchInput':
      return branchInputValidator;
    default:
      throw new Error(`Unknown RR-08 durable assurance schema ${schema}.`);
  }
};

const joinPolicy = (value: {
  readonly kind: string;
  readonly successfulOutcomes: readonly string[];
  readonly remaining: string;
  readonly count?: number;
}): ParallelJoinPolicy => {
  if (value.remaining !== 'cancel' && value.remaining !== 'drain') {
    throw new Error('RR-08 join vector has an invalid remaining policy.');
  }
  if (value.kind === 'all' || value.kind === 'any') {
    return {
      kind: value.kind,
      successfulOutcomes: value.successfulOutcomes,
      remaining: value.remaining,
    };
  }
  if (value.kind === 'threshold' && value.count !== undefined) {
    return {
      kind: 'threshold',
      successfulOutcomes: value.successfulOutcomes,
      remaining: value.remaining,
      count: value.count,
    };
  }
  throw new Error('RR-08 join vector has an invalid policy.');
};

describe('RR-08 assurance artifacts', () => {
  it('pins exact checked-in fixture bytes and contract metadata', () => {
    expect(digest(goldenName)).toBe(
      '24a8b905c5e1f6a7f32803a930a024a7b9811a63737a6df6b1ac8a4eb2ea2944',
    );
    expect(digest(matrixName)).toBe(
      '93be7c62032c38bb06d4b516b0feae0ff30f966b1237ad3824c1a84ba9010a86',
    );
    expect(goldenJson.metadata).toStrictEqual(metadata);
    expect(matrixJson.metadata).toStrictEqual(metadata);
  });

  it.each(goldenJson.publicObservations)(
    'validates public observation vector $id',
    ({ schema, value, valid }) => {
      expect(publicValidator(schema).Check(value)).toBe(valid);
    },
  );

  it.each(goldenJson.durableVectors)(
    'validates durable protocol vector $id',
    ({ schema, value, valid }) => {
      expect(durableValidator(schema).Check(value)).toBe(valid);
    },
  );

  it('executes join vectors and keeps the decisive prefix immutable after late settlements', () => {
    for (const vector of goldenJson.joinCases) {
      let state = initialParallelJoinState();
      for (const settlement of vector.settlements) {
        state = settleParallelBranch(
          joinPolicy(vector.policy),
          vector.authoredBranchKeys,
          state,
          settlement,
        );
      }
      expect(state.decision).toStrictEqual(vector.expected);
      expect(eligibleParallelResults(state).map(({ key }) => key)).toStrictEqual(
        vector.expected.outputEligibleBranchKeys,
      );
      expect(state.settlements).toHaveLength(vector.settlements.length);
      expect(
        initialDecisionIndex(
          joinPolicy(vector.policy),
          vector.authoredBranchKeys,
          vector.settlements,
        ),
      ).toBe(vector.decisionAfter);
    }
  });

  it('binds every context coordinate to an exact executable test and source assertion', () => {
    const expectedAxes = {
      joinKind: ['all', 'any', 'threshold'],
      settlementOrder: ['authored', 'reverse', 'interleaved'],
      remaining: ['cancel', 'drain'],
      decisionOutcome: ['succeeded', 'failed'],
      admission: ['initial', 'beforeDecision', 'afterDecision'],
      startDirective: ['start', 'startCancelled'],
      branchDisposition: ['execute', 'settlementOnly', 'skipped'],
      providerState: ['queued', 'active', 'settled'],
      operation: ['execute', 'reconcile'],
      processBoundary: [
        'sameProcess',
        'crashAfterSelection',
        'crashAfterExecute',
        'crashAfterDecision',
      ],
      capacity: ['one', 'two', 'sharedAcrossBranches'],
      observation: ['running', 'cancelled', 'skipped', 'terminalJoin'],
      protocolEvidence: ['singleRegistration', 'currentContractSurface', 'noncanonicalRejected'],
    } satisfies Readonly<Record<string, readonly string[]>>;
    expect(matrixJson.axes).toStrictEqual(expectedAxes);

    const proofCases = matrixJson.proofCases;
    for (const [axis, values] of Object.entries(expectedAxes)) {
      const witnessed = new Set(
        proofCases.flatMap((proof) =>
          Object.entries(proof).flatMap(([key, value]) =>
            key === axis && typeof value === 'string' ? [value] : [],
          ),
        ),
      );
      expect(witnessed).toEqual(new Set(values));
    }
    expect(new Set(matrixJson.proofCases.map(({ scenario }) => scenario))).toEqual(
      new Set(['rr-034', 'rr-035', 'rr-078']),
    );
    for (const proof of matrixJson.proofCases) {
      const testSource = readFileSync(
        new URL(`../../${proof.evidence.testFile}`, import.meta.url),
        'utf8',
      );
      const assertionSource = readFileSync(
        new URL(`../../${proof.evidence.assertionFile}`, import.meta.url),
        'utf8',
      );
      expect(testSource).toContain(proof.evidence.testName);
      for (const assertion of proof.evidence.assertions) {
        expect(assertionSource).toContain(assertion);
      }
    }
    for (const exclusion of matrixJson.exclusions) {
      const source = readFileSync(
        new URL(`../../${exclusion.sourceFile}`, import.meta.url),
        'utf8',
      );
      expect(exclusion.reason.length).toBeGreaterThan(40);
      for (const assertion of exclusion.sourceAssertions) {
        expect(source).toContain(assertion);
      }
    }
  });

  it('keeps the rr034, rr035, and rr078 witnesses aligned with their executable scenarios', () => {
    const byId = new Map(matrixJson.proofCases.map((proof) => [proof.id, proof]));
    expect(byId.get('rr034-threshold-cancel-success')).toMatchObject({
      joinKind: 'threshold',
      remaining: 'cancel',
      decisionOutcome: 'succeeded',
      observation: 'cancelled',
      scenario: 'rr-034',
    });
    expect(byId.get('rr035-threshold-unreachable')).toMatchObject({
      joinKind: 'threshold',
      remaining: 'cancel',
      decisionOutcome: 'failed',
      observation: 'cancelled',
      scenario: 'rr-035',
    });
    expect(byId.get('rr078-parallel-recovery')).toMatchObject({
      joinKind: 'all',
      remaining: 'drain',
      decisionOutcome: 'succeeded',
      processBoundary: 'crashAfterExecute',
      scenario: 'rr-078',
    });
  });
});

const initialDecisionIndex = (
  policy: ParallelJoinPolicy,
  authoredBranchKeys: readonly string[],
  settlements: readonly ParallelBranchResult[],
): number | undefined => {
  let state = initialParallelJoinState();
  for (const [index, settlement] of settlements.entries()) {
    state = settleParallelBranch(policy, authoredBranchKeys, state, settlement);
    if (state.decision !== undefined) {
      return index + 1;
    }
  }
  return undefined;
};
