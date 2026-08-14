import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Type from 'typebox';
import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { parseDbosWorkflowStatus } from '../../src/validation/dbos-workflow-status.validator.js';
import { parseParallelBranchResult } from '../../src/validation/parallel-branch-result.validator.js';
import { parseRunEvent } from '../../src/validation/run-event.validator.js';

const sourceRevision = '1fb508fffc76dd9946994f0d57cd274b5d6f25d7';
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rr04');
const repositoryRoot = resolve(fixtureDirectory, '../../..');

const GoldenVectorSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    operation: Type.Union([
      Type.Literal('parseRunEvent'),
      Type.Literal('parseParallelBranchResult'),
      Type.Literal('parseDbosWorkflowStatus'),
    ]),
    input: Type.Unknown(),
    expected: Type.Union([
      Type.Object(
        { kind: Type.Literal('output'), value: Type.Unknown() },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal('error'), message: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

const GoldenArtifactSchema = Type.Object(
  {
    contract: Type.Literal('rr-04-read-observe-api'),
    artifactVersion: Type.Literal(2),
    sourceRevision: Type.String(),
    vectors: Type.Array(GoldenVectorSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ContextEvidenceSchema = Type.Object(
  { file: Type.String({ minLength: 1 }), anchor: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ContextCaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    covers: Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }))),
    evidence: Type.Array(ContextEvidenceSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ContextMatrixSchema = Type.Object(
  {
    contract: Type.Literal('rr-04-read-observe-api'),
    artifactVersion: Type.Literal(2),
    sourceRevision: Type.String(),
    axes: Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    cases: Type.Array(ContextCaseSchema, { minItems: 1 }),
    exclusions: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          reason: Type.String({ minLength: 1 }),
          evidence: Type.Array(ContextEvidenceSchema, { minItems: 1 }),
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

const load = <Value>(filename: string, validator: { Check(value: unknown): value is Value }) => {
  const bytes = readFileSync(resolve(fixtureDirectory, filename));
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!validator.Check(value)) {
    throw new Error(`RR-04 assurance artifact ${filename} is invalid.`);
  }
  return { bytes, value };
};

const execute = (operation: string, input: unknown): unknown => {
  try {
    let value;
    switch (operation) {
      case 'parseRunEvent':
        value = parseRunEvent(input);
        break;
      case 'parseParallelBranchResult':
        value = parseParallelBranchResult(input);
        break;
      case 'parseDbosWorkflowStatus':
        value = parseDbosWorkflowStatus(input);
        break;
      default:
        throw new Error(`Unknown RR-04 golden vector operation ${operation}.`);
    }
    return { kind: 'output', value };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

describe('RR-04 repository-owned assurance artifacts', () => {
  it('pins and executes every digested golden vector', () => {
    const { bytes, value } = load('observation-golden-vectors.json', goldenValidator);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '0d7a601890534910709b271d51bf04215effb8a86de6dd0505498c74b69b807d',
    );
    expect(value.sourceRevision).toBe(sourceRevision);
    expect(new Set(value.vectors.map(({ id }) => id)).size).toBe(value.vectors.length);
    for (const vector of value.vectors) {
      expect(execute(vector.operation, vector.input)).toEqual(vector.expected);
    }
  });

  it('pins a complete context matrix with executable evidence and explicit exclusions', () => {
    const { bytes, value } = load('observation-context-matrix.json', matrixValidator);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '66330ec11c137ea43b61bd52f1ffc099b7910e6fc93250a130aea8ccb60f80c1',
    );
    expect(value.sourceRevision).toBe(sourceRevision);
    expect(new Set(value.cases.map(({ id }) => id)).size).toBe(value.cases.length);
    for (const [axis, axisValues] of Object.entries(value.axes)) {
      for (const axisValue of axisValues) {
        if (!value.cases.some(({ covers }) => covers[axis]?.includes(axisValue) === true)) {
          throw new Error(`RR-04 context matrix does not cover ${axis}:${axisValue}.`);
        }
      }
    }
    for (const contextCase of value.cases) {
      for (const [axis, coveredValues] of Object.entries(contextCase.covers)) {
        const allowedValues = value.axes[axis];
        if (allowedValues === undefined) {
          throw new Error(`RR-04 case ${contextCase.id} refers to unknown axis ${axis}.`);
        }
        for (const coveredValue of coveredValues) {
          if (!allowedValues.includes(coveredValue)) {
            throw new Error(
              `RR-04 case ${contextCase.id} refers to unknown ${axis} value ${coveredValue}.`,
            );
          }
        }
      }
    }
    for (const evidence of [
      ...value.cases.flatMap(({ evidence: evidencePaths }) => evidencePaths),
      ...value.exclusions.flatMap(({ evidence: evidencePaths }) => evidencePaths),
    ]) {
      const evidencePath = resolve(repositoryRoot, evidence.file);
      if (!existsSync(evidencePath)) {
        throw new Error(`RR-04 matrix evidence ${evidence.file} does not exist.`);
      }
      if (!readFileSync(evidencePath, 'utf8').includes(evidence.anchor)) {
        throw new Error(
          `RR-04 matrix evidence ${evidence.file} does not contain ${evidence.anchor}.`,
        );
      }
    }
  });
});
