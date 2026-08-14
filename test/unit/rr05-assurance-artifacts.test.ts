import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Type from 'typebox';
import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { RunExecutorResultSchema } from '../../src/contracts/executor/run-executor.js';
import { nodeAttemptStepIdentity, nodeEffectDecisionStepName } from '../../src/dbos/dbos-names.js';
import { mapRunAttempt } from '../../src/dbos/read-model/map-run-attempt.js';
import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import type { RunExecutorRequest } from '../../src/index.js';
import { createAttemptId } from '../../src/pipeline/identity/execution-identity.js';
import { parseRunWorkflowInput } from '../../src/validation/parse-run-workflow-data.js';
import { observable, plan, runId, step } from '../support/run-details.fixture.js';

const sourceRevision = '20bb6b95bb0f94867e177041a9f1d27d7e2f6241';
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rr05');
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

const AttemptDescriptorSchema = Type.Union([
  Type.Object(
    {
      ordinal: Type.Integer({ minimum: 1 }),
      result: RunExecutorResultSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ordinal: Type.Integer({ minimum: 1 }),
      stepError: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const MapAttemptsInputSchema = Type.Array(AttemptDescriptorSchema, { minItems: 1 });

const StepNameInputSchema = Type.Object(
  { path: Type.String({ minLength: 1 }), ordinal: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

const AttemptIdInputSchema = Type.Object(
  {
    nodeInstanceId: Type.String({ minLength: 1 }),
    ordinal: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const GoldenVectorSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    operation: Type.Union([
      Type.Literal('runWorkflowId'),
      Type.Literal('parseRunWorkflowInput'),
      Type.Literal('nodeEffectDecisionStepName'),
      Type.Literal('nodeAttemptStepIdentity'),
      Type.Literal('createAttemptId'),
      Type.Literal('mapRunAttempts'),
    ]),
    input: Type.Unknown(),
    expected: ExpectedSchema,
  },
  { additionalProperties: false },
);

const GoldenArtifactSchema = Type.Object(
  {
    contract: Type.Literal('rr-05-attempt-retry-timeout'),
    artifactVersion: Type.Literal(1),
    sourceRevision: Type.String(),
    vectors: Type.Array(GoldenVectorSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ContextEvidenceSchema = Type.Object(
  { file: Type.String({ minLength: 1 }), anchor: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ContextCoverageSchema = Type.Record(
  Type.String(),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
);

const ContextEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    covers: ContextCoverageSchema,
    evidence: Type.Array(ContextEvidenceSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ContextMatrixSchema = Type.Object(
  {
    contract: Type.Literal('rr-05-attempt-retry-timeout'),
    artifactVersion: Type.Literal(1),
    sourceRevision: Type.String(),
    axes: Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    cases: Type.Array(ContextEntrySchema, { minItems: 1 }),
    exclusions: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          covers: ContextCoverageSchema,
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
const runIdInputValidator = Schema.Compile(Type.String());
const workflowInputValidator = Schema.Compile(
  Type.Array(Type.Unknown(), { minItems: 1, maxItems: 1 }),
);
const stepNameInputValidator = Schema.Compile(StepNameInputSchema);
const attemptIdInputValidator = Schema.Compile(AttemptIdInputSchema);
const mapAttemptsInputValidator = Schema.Compile(MapAttemptsInputSchema);

const load = <Value>(filename: string, validator: { Check(value: unknown): value is Value }) => {
  const bytes = readFileSync(resolve(fixtureDirectory, filename));
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!validator.Check(value)) {
    throw new Error(`RR-05 assurance artifact ${filename} is invalid.`);
  }
  return { bytes, value };
};

const validateInput = <Value>(
  operation: string,
  input: unknown,
  validator: { Check(value: unknown): value is Value },
): Value => {
  if (!validator.Check(input)) {
    throw new Error(`RR-05 golden vector ${operation} input is invalid.`);
  }
  return input;
};

const candidate = observable.nodesByDisplayPath.get('main/root-work');
if (candidate === undefined) {
  throw new Error('RR-05 assurance candidate is missing.');
}
const binding = plan.bindings.find(
  ({ target }) =>
    target.pipelineId === candidate.pipelineId && target.nodePath === candidate.nodePath,
);
if (binding === undefined) {
  throw new Error('RR-05 assurance binding is missing.');
}

const request = (attemptOrdinal: number): RunExecutorRequest => ({
  runId,
  scopeId: candidate.scopeId,
  authoredNodeId: candidate.authoredNodeId,
  nodeInstanceId: candidate.id,
  attemptId: createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal }),
  attemptOrdinal,
  pipelineId: candidate.pipelineId,
  nodePath: candidate.nodePath,
  displayPath: candidate.displayPath,
  binding,
  input: {},
});

const mapAttempts = (attempts: Type.Static<typeof MapAttemptsInputSchema>) =>
  attempts.map((attempt, index) => {
    const operation =
      'stepError' in attempt
        ? { error: new Error(attempt.stepError) }
        : {
            output: {
              kind: 'runNodeExecution' as const,
              request: request(attempt.ordinal),
              result: attempt.result,
            },
          };
    return mapRunAttempt(
      step(
        index + 1,
        nodeEffectDecisionStepName(candidate.displayPath, attempt.ordinal),
        operation,
      ),
      candidate,
      runId,
      attempt.ordinal,
    );
  });

const execute = (operation: string, input: unknown): unknown => {
  try {
    let value;
    switch (operation) {
      case 'runWorkflowId':
        value = runWorkflowId(validateInput(operation, input, runIdInputValidator));
        break;
      case 'parseRunWorkflowInput':
        value = parseRunWorkflowInput(validateInput(operation, input, workflowInputValidator));
        break;
      case 'nodeEffectDecisionStepName': {
        const stepInput = validateInput(operation, input, stepNameInputValidator);
        value = nodeEffectDecisionStepName(stepInput.path, stepInput.ordinal);
        break;
      }
      case 'nodeAttemptStepIdentity':
        value = nodeAttemptStepIdentity(validateInput(operation, input, runIdInputValidator));
        break;
      case 'createAttemptId': {
        const attemptInput = validateInput(operation, input, attemptIdInputValidator);
        value = createAttemptId({
          nodeInstanceId: attemptInput.nodeInstanceId,
          attemptOrdinal: attemptInput.ordinal,
        });
        break;
      }
      case 'mapRunAttempts':
        value = mapAttempts(validateInput(operation, input, mapAttemptsInputValidator));
        break;
      default:
        throw new Error(`Unknown RR-05 golden vector operation ${operation}.`);
    }
    const normalized: unknown = JSON.parse(JSON.stringify(value));
    return { kind: 'output', value: normalized };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
};

const assertCoverageReferencesKnownAxes = (
  axes: Readonly<Record<string, readonly string[]>>,
  entries: readonly { readonly id: string; readonly covers: Record<string, string[]> }[],
): void => {
  for (const entry of entries) {
    for (const [axis, coveredValues] of Object.entries(entry.covers)) {
      const allowedValues = axes[axis];
      if (allowedValues === undefined) {
        throw new Error(`RR-05 context ${entry.id} refers to unknown axis ${axis}.`);
      }
      for (const coveredValue of coveredValues) {
        if (!allowedValues.includes(coveredValue)) {
          throw new Error(`RR-05 context ${entry.id} refers to unknown ${axis}:${coveredValue}.`);
        }
      }
    }
  }
};

describe('RR-05 repository-owned assurance artifacts', () => {
  it('pins and executes every digested golden vector', () => {
    const { bytes, value } = load('attempt-retry-timeout-golden-vectors.json', goldenValidator);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '710071813510064282663aa12a5895821568b475bf63c17fd72e74b745ebdd41',
    );
    expect(value.sourceRevision).toBe(sourceRevision);
    expect(new Set(value.vectors.map(({ id }) => id)).size).toBe(value.vectors.length);
    for (const vector of value.vectors) {
      expect(execute(vector.operation, vector.input)).toEqual(vector.expected);
    }
  });

  it('pins complete context axes with executable evidence and explicit exclusions', () => {
    const { bytes, value } = load('attempt-retry-timeout-context-matrix.json', matrixValidator);

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '3a78b7df52097017286ca42d3c87ba2e1faed97ef1ed53b816d9bf2b8ce18c78',
    );
    expect(value.sourceRevision).toBe(sourceRevision);
    const entries = [...value.cases, ...value.exclusions];
    expect(new Set(entries.map(({ id }) => id)).size).toBe(entries.length);
    assertCoverageReferencesKnownAxes(value.axes, entries);
    for (const [axis, axisValues] of Object.entries(value.axes)) {
      for (const axisValue of axisValues) {
        if (!entries.some(({ covers }) => covers[axis]?.includes(axisValue) === true)) {
          throw new Error(`RR-05 context matrix does not address ${axis}:${axisValue}.`);
        }
      }
    }
    for (const evidence of entries.flatMap(({ evidence: evidenceItems }) => evidenceItems)) {
      const evidencePath = resolve(repositoryRoot, evidence.file);
      if (!existsSync(evidencePath)) {
        throw new Error(`RR-05 matrix evidence ${evidence.file} does not exist.`);
      }
      if (!readFileSync(evidencePath, 'utf8').includes(evidence.anchor)) {
        throw new Error(
          `RR-05 matrix evidence ${evidence.file} does not contain ${evidence.anchor}.`,
        );
      }
    }
  });
});
