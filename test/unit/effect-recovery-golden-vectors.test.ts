import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Type from 'typebox';
import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import {
  nodeReconciliationOutcomeStepName,
  nodeReconciliationStepIdentity,
} from '../../src/dbos/dbos-names.js';
import { mapRunAttempt } from '../../src/dbos/read-model/map-run-attempt.js';
import {
  parseRunNodeEffectDecision,
  parseRunNodeEffectIntent,
  parseRunNodeReconciliation,
  validReconciliationResult,
} from '../../src/validation/run-node-recovery.validator.js';
import { observable, runId, step, storedNodeExecution } from '../support/run-details.fixture.js';

const sourceRevision = 'd0287e798a0e3d62acb0b08f2ee7d545df9efa63';
const cloudRevision = 'Xx-qwSEgx953UpLTLlTjo';
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rr06');
const repositoryRoot = resolve(fixtureDirectory, '../../..');

const ExpectedSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('output'), value: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('error'), message: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

const GoldenArtifactSchema = Type.Object(
  {
    contract: Type.Literal('rr-06-effect-recovery'),
    artifactVersion: Type.Literal(1),
    sourceRevision: Type.String(),
    cloudRevision: Type.String(),
    vectors: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          operation: Type.Union([
            Type.Literal('validateReconciliationResult'),
            Type.Literal('parseIntent'),
            Type.Literal('parseDecision'),
            Type.Literal('parseReconciliation'),
            Type.Literal('parseReconciliationStepIdentity'),
            Type.Literal('mapOutcomeUnknownObservation'),
          ]),
          input: Type.Unknown(),
          expected: ExpectedSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

const EvidenceSchema = Type.Object(
  { file: Type.String({ minLength: 1 }), anchor: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const CoverageSchema = Type.Record(
  Type.String(),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
);
const ContextEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    covers: CoverageSchema,
    evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const ContextMatrixSchema = Type.Object(
  {
    contract: Type.Literal('rr-06-effect-recovery'),
    artifactVersion: Type.Literal(1),
    sourceRevision: Type.String(),
    cloudRevision: Type.String(),
    axes: Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    cases: Type.Array(ContextEntrySchema, { minItems: 1 }),
    exclusions: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          covers: CoverageSchema,
          reason: Type.String({ minLength: 1 }),
          evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

const goldenValidator = Schema.Compile(GoldenArtifactSchema);
const matrixValidator = Schema.Compile(ContextMatrixSchema);
const roundInputValidator = Schema.Compile(
  Type.Object(
    { reconciliationRound: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) },
    { additionalProperties: false },
  ),
);
const nameInputValidator = Schema.Compile(Type.String({ minLength: 1 }));

const load = <Value>(filename: string, validator: { Check(value: unknown): value is Value }) => {
  const bytes = readFileSync(resolve(fixtureDirectory, filename));
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!validator.Check(value)) {
    throw new Error(`RR-06 assurance artifact ${filename} is invalid.`);
  }
  return { bytes, value };
};

const validateInput = <Value>(
  operation: string,
  input: unknown,
  validator: { Check(value: unknown): value is Value },
): Value => {
  if (!validator.Check(input)) {
    throw new Error(`RR-06 golden vector ${operation} input is invalid.`);
  }
  return input;
};

const candidate = observable.nodesByDisplayPath.get('main/root-work');
if (candidate === undefined) {
  throw new Error('RR-06 assurance candidate is missing.');
}
const request = storedNodeExecution('main/root-work', 'completed').request;

const mapOutcomeUnknownObservation = (input: unknown): unknown => {
  const { reconciliationRound } = validateInput(
    'mapOutcomeUnknownObservation',
    input,
    roundInputValidator,
  );
  const attempt = mapRunAttempt(
    step(1, nodeReconciliationOutcomeStepName(candidate.displayPath, 1, reconciliationRound), {
      output: {
        kind: 'runNodeReconciliation',
        request,
        reconciliationRound,
        result: { kind: 'outcomeUnknown' },
      },
    }),
    candidate,
    runId,
    1,
  );
  if (attempt?.status !== 'outcomeUnknown') {
    throw new Error('RR-06 outcome-unknown vector did not map an attempt.');
  }
  return { status: attempt.status, recovery: attempt.recovery };
};

const execute = (operation: string, input: unknown): unknown => {
  try {
    let value;
    switch (operation) {
      case 'validateReconciliationResult':
        value = validReconciliationResult(input);
        break;
      case 'parseIntent':
        value = parseRunNodeEffectIntent(input);
        break;
      case 'parseDecision':
        value = parseRunNodeEffectDecision(input);
        break;
      case 'parseReconciliation':
        value = parseRunNodeReconciliation(input);
        break;
      case 'parseReconciliationStepIdentity':
        value = nodeReconciliationStepIdentity(validateInput(operation, input, nameInputValidator));
        break;
      case 'mapOutcomeUnknownObservation':
        value = mapOutcomeUnknownObservation(input);
        break;
      default:
        throw new Error(`Unknown RR-06 golden vector operation ${operation}.`);
    }
    return { kind: 'output', value };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
};

describe('repository-owned assurance artifacts', () => {
  it('pins and executes the recovery golden vectors', () => {
    const { bytes, value } = load('effect-recovery-golden-vectors.json', goldenValidator);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'da0bf223c54ec213519e6812494e5f1fdbfc46c94374565730eef594928795c4',
    );
    expect(value.sourceRevision).toBe(sourceRevision);
    expect(value.cloudRevision).toBe(cloudRevision);
    expect(new Set(value.vectors.map(({ id }) => id)).size).toBe(value.vectors.length);
    for (const vector of value.vectors) {
      expect(execute(vector.operation, vector.input)).toEqual(vector.expected);
    }
  });

  it('pins every approved context axis to executable evidence or an explicit exclusion', () => {
    const { bytes, value } = load('effect-recovery-context-matrix.json', matrixValidator);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'e9fc164e071a72fcb290591c56e185c8c25cf195f0b3066fc4a71806377cd9bb',
    );
    expect(value.sourceRevision).toBe(sourceRevision);
    expect(value.cloudRevision).toBe(cloudRevision);
    const entries = [...value.cases, ...value.exclusions];
    expect(new Set(entries.map(({ id }) => id)).size).toBe(entries.length);
    for (const [axis, values] of Object.entries(value.axes)) {
      for (const axisValue of values) {
        expect(entries.some(({ covers }) => covers[axis]?.includes(axisValue) === true)).toBe(true);
      }
    }
    for (const entry of entries) {
      for (const [axis, values] of Object.entries(entry.covers)) {
        expect(value.axes[axis]).toEqual(expect.arrayContaining(values));
      }
      for (const evidence of entry.evidence) {
        const path = resolve(repositoryRoot, evidence.file);
        if (!existsSync(path)) {
          throw new Error(`RR-06 matrix evidence ${evidence.file} does not exist.`);
        }
        if (!readFileSync(path, 'utf8').includes(evidence.anchor)) {
          throw new Error(
            `RR-06 matrix evidence ${evidence.file} does not contain ${evidence.anchor}.`,
          );
        }
      }
    }
  });
});
