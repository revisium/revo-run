import { readFile } from 'node:fs/promises';

import { Type, type Static } from 'typebox';
import { Parse } from 'typebox/value';

import { isJsonObject, JsonValueSchema, type JsonValue } from '../../src/contracts/json.js';

const closed = <T extends Record<string, import('typebox').TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const nonEmpty = Type.String({ minLength: 1 });
const identifiers = Type.Array(nonEmpty, { minItems: 1, uniqueItems: true });

const ArchitectureSchema = closed({
  schemaVersion: Type.Literal('rn1-codex-approved-architecture/v3'),
  artifactRevision: nonEmpty,
  normalization: closed({
    encoding: Type.Literal('UTF-8'),
    separator: Type.Literal('LF'),
    terminalNewline: Type.Literal(false),
    form: nonEmpty,
  }),
  normalizedTextSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  constraints: Type.Array(
    closed({ ordinal: Type.Integer({ minimum: 1 }), id: nonEmpty, text: nonEmpty }),
    { minItems: 1 },
  ),
});

const ImmutableEvidenceSchema = closed({ kind: nonEmpty, locator: nonEmpty, value: nonEmpty });
const EvidenceClassSchema = Type.Union([
  Type.Literal('executable-vector'),
  Type.Literal('route-gate'),
  Type.Literal('source-backed-exclusion'),
]);
const SourceRequirementsSchema = closed({
  schemaVersion: Type.Literal('rn1-codex-source-requirements/v3'),
  artifactRevision: nonEmpty,
  sources: Type.Array(
    closed({
      id: nonEmpty,
      locator: nonEmpty,
      immutablePin: closed({ kind: nonEmpty, value: nonEmpty }),
      immutabilityEvidence: Type.Optional(Type.Array(ImmutableEvidenceSchema, { minItems: 1 })),
    }),
    { minItems: 1 },
  ),
  routeGates: Type.Array(
    closed({
      id: nonEmpty,
      evidenceClass: Type.Literal('route-gate'),
      command: nonEmpty,
      requirements: identifiers,
    }),
    { minItems: 1 },
  ),
  requirements: Type.Array(
    closed({
      id: nonEmpty,
      evidenceClass: EvidenceClassSchema,
      sourceId: nonEmpty,
      locator: nonEmpty,
      text: nonEmpty,
    }),
    { minItems: 1 },
  ),
});

const GoldenVectorSchema = closed({
  id: nonEmpty,
  evidenceClass: Type.Literal('executable-vector'),
  kind: nonEmpty,
  input: Type.Optional(JsonValueSchema),
  expected: JsonValueSchema,
  requirements: identifiers,
});
const GoldenVectorsSchema = closed({
  schemaVersion: Type.Literal('rn1-codex-golden-vectors/v3'),
  vectors: Type.Array(GoldenVectorSchema, { minItems: 1 }),
});

const axisNames = [
  'platform',
  'dependency',
  'surface',
  'definition',
  'model',
  'prompt',
  'auth',
  'credentials',
  'workspace',
  'terminal',
  'acquire',
  'start',
  'recovery',
  'provider',
] as const;
const AxisValuesSchema = Type.Array(nonEmpty, { minItems: 1, uniqueItems: true });
const AxesSchema = closed(Object.fromEntries(axisNames.map((name) => [name, AxisValuesSchema])));
const CoordinatesSchema = Type.Partial(
  closed(Object.fromEntries(axisNames.map((name) => [name, nonEmpty]))),
);
const ContextCaseSchema = closed({
  id: nonEmpty,
  coordinates: CoordinatesSchema,
  input: JsonValueSchema,
  expected: JsonValueSchema,
  requirements: identifiers,
  evidence: closed({
    consumer: nonEmpty,
    evidenceClass: Type.Literal('executable-vector'),
  }),
});
const ExclusionSchema = closed({
  id: nonEmpty,
  evidenceClass: Type.Literal('source-backed-exclusion'),
  excluded: nonEmpty,
  requiredEvidence: nonEmpty,
  reason: nonEmpty,
  sourceIds: identifiers,
  requirements: identifiers,
});
const ContextVectorsSchema = closed({
  schemaVersion: Type.Literal('rn1-codex-context-vectors/v3'),
  axes: AxesSchema,
  cases: Type.Array(ContextCaseSchema, { minItems: 1 }),
  exclusions: Type.Array(ExclusionSchema, { minItems: 1 }),
});

const ManifestArtifactSchema = closed({
  path: nonEmpty,
  digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
});
const ManifestSchema = closed({
  schemaVersion: Type.Literal('rn1-codex-governing-manifest/v3'),
  algorithm: Type.Literal('sha256'),
  artifacts: Type.Array(ManifestArtifactSchema, { minItems: 1 }),
  governingArtifactsDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
});

export type ApprovedArchitecture = Static<typeof ArchitectureSchema>;
export type SourceRequirements = Static<typeof SourceRequirementsSchema>;
export type GoldenVector = Static<typeof GoldenVectorSchema>;
export type ContextCase = Static<typeof ContextCaseSchema>;
export type ContextVectors = Static<typeof ContextVectorsSchema>;
export type GoverningManifest = Static<typeof ManifestSchema>;

const parseJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));

export const loadCodexConformance = async (): Promise<
  Readonly<{
    architecture: ApprovedArchitecture;
    requirements: SourceRequirements;
    golden: readonly GoldenVector[];
    context: ContextVectors;
    manifest: GoverningManifest;
  }>
> => {
  const [architecture, requirements, golden, context, manifest] = await Promise.all([
    parseJson('docs/conformance/rn1-codex-approved-architecture.json'),
    parseJson('docs/conformance/rn1-codex-source-requirements.json'),
    parseJson('test/fixtures/conformance/rn1-codex-golden-vectors.json'),
    parseJson('test/fixtures/conformance/rn1-codex-context-vectors.json'),
    parseJson('docs/conformance/rn1-codex-governing-manifest.json'),
  ]);
  const parsedGolden = Parse(GoldenVectorsSchema, golden);
  return Object.freeze({
    architecture: Parse(ArchitectureSchema, architecture),
    requirements: Parse(SourceRequirementsSchema, requirements),
    golden: parsedGolden.vectors,
    context: Parse(ContextVectorsSchema, context),
    manifest: Parse(ManifestSchema, manifest),
  });
};

export const codexContextCase = async (id: string): Promise<ContextCase> => {
  const value = (await loadCodexConformance()).context.cases.find((entry) => entry.id === id);
  if (value === undefined) {
    throw new Error(`Unknown Codex context case ${id}.`);
  }
  return value;
};

const stringArray = (value: JsonValue | undefined, label: string): readonly string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
};

type WrapperVector = Readonly<{ opener: string; closer: string }>;
const isWrapperVector = (value: unknown): value is WrapperVector =>
  isJsonObject(value) && typeof value.opener === 'string' && typeof value.closer === 'string';

export type TerminalPathComplexityParameters = Readonly<{
  semanticRepeats: number;
  apostrophePattern: string;
  parenthesisPattern: string;
  squarePattern: string;
  equalByteBudget: Readonly<{
    smallBytes: number;
    smallIterations: number;
    largeBytes: number;
    largeIterations: number;
    samples: number;
    ratioCeiling: number;
    fixedAllowanceMs: number;
  }>;
  nearLimit: Readonly<{ bytes: number; timeoutMs: number }>;
}>;

const positiveNumber = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export const terminalPathComplexityParameters = (
  input: JsonValue,
): TerminalPathComplexityParameters => {
  if (
    !isJsonObject(input) ||
    !isJsonObject(input.properties) ||
    !isJsonObject(input.properties.complexity)
  ) {
    throw new Error('Terminal path context input must contain complexity parameters.');
  }
  const complexity = input.properties.complexity;
  const equalByteBudget = complexity.equalByteBudget;
  const nearLimit = complexity.nearLimit;
  if (
    !isJsonObject(equalByteBudget) ||
    !isJsonObject(nearLimit) ||
    !positiveNumber(complexity.semanticRepeats) ||
    typeof complexity.apostrophePattern !== 'string' ||
    typeof complexity.parenthesisPattern !== 'string' ||
    typeof complexity.squarePattern !== 'string' ||
    !positiveNumber(equalByteBudget.smallBytes) ||
    !positiveNumber(equalByteBudget.smallIterations) ||
    !positiveNumber(equalByteBudget.largeBytes) ||
    !positiveNumber(equalByteBudget.largeIterations) ||
    !positiveNumber(equalByteBudget.samples) ||
    !positiveNumber(equalByteBudget.ratioCeiling) ||
    !positiveNumber(equalByteBudget.fixedAllowanceMs) ||
    !positiveNumber(nearLimit.bytes) ||
    !positiveNumber(nearLimit.timeoutMs)
  ) {
    throw new Error('Terminal path complexity parameters are invalid.');
  }
  return Object.freeze({
    semanticRepeats: complexity.semanticRepeats,
    apostrophePattern: complexity.apostrophePattern,
    parenthesisPattern: complexity.parenthesisPattern,
    squarePattern: complexity.squarePattern,
    equalByteBudget: Object.freeze({
      smallBytes: equalByteBudget.smallBytes,
      smallIterations: equalByteBudget.smallIterations,
      largeBytes: equalByteBudget.largeBytes,
      largeIterations: equalByteBudget.largeIterations,
      samples: equalByteBudget.samples,
      ratioCeiling: equalByteBudget.ratioCeiling,
      fixedAllowanceMs: equalByteBudget.fixedAllowanceMs,
    }),
    nearLimit: Object.freeze({ bytes: nearLimit.bytes, timeoutMs: nearLimit.timeoutMs }),
  });
};

export const terminalPathLongSemanticVectors = (
  input: JsonValue,
): Readonly<{
  safe: readonly Readonly<{ id: string; value: string }>[];
  unsafe: readonly string[];
}> => {
  const complexity = terminalPathComplexityParameters(input);
  const apostropheBody = complexity.apostrophePattern.repeat(complexity.semanticRepeats);
  const parenthesisBody = complexity.parenthesisPattern.repeat(complexity.semanticRepeats);
  const lastParenthesis = parenthesisBody.lastIndexOf(')');
  if (lastParenthesis === -1) {
    throw new Error('Terminal parenthesis pattern has no ambiguous closer.');
  }
  const squareBody = complexity.squarePattern.repeat(complexity.semanticRepeats);
  return Object.freeze({
    safe: Object.freeze([
      Object.freeze({
        id: 'apostrophe-final',
        value: `'https://example.invalid/${apostropheBody}tail'`,
      }),
      Object.freeze({
        id: 'parenthesis-final',
        value: `(https://example.invalid/${parenthesisBody}tail)`,
      }),
      Object.freeze({
        id: 'square-prose-final',
        value: `[https://[2001:db8::1]/${squareBody}tail]`,
      }),
    ]),
    unsafe: Object.freeze([
      `'https://example.invalid/${apostropheBody}tail/private`,
      `(https://example.invalid/${parenthesisBody.slice(0, lastParenthesis + 1)}/private`,
    ]),
  });
};

export const expandTerminalPathContextInput = (
  input: JsonValue,
): Readonly<{ unsafe: readonly string[]; safe: readonly string[] }> => {
  if (!isJsonObject(input) || !isJsonObject(input.properties)) {
    throw new Error('Terminal path context input must contain property vectors.');
  }
  const properties = input.properties;
  const authorities = stringArray(properties.authorities, 'Terminal authorities');
  const punctuation = stringArray(properties.punctuation, 'Terminal punctuation');
  const subdelimiters = stringArray(properties.subdelimiters, 'Terminal sub-delimiters');
  const unknownCharacters = stringArray(
    properties.unknownCharacters,
    'Terminal unknown characters',
  );
  const wrappers = properties.wrappers;
  if (
    !Array.isArray(wrappers) ||
    !wrappers.every(isWrapperVector) ||
    typeof properties.authorityCharacters !== 'string' ||
    typeof properties.componentSuffix !== 'string' ||
    typeof properties.wrapperUrl !== 'string'
  ) {
    throw new Error('Terminal path property vectors are invalid.');
  }
  const safe = new Set(stringArray(input.safe, 'Safe terminal vectors'));
  const unsafe = new Set(stringArray(input.unsafe, 'Unsafe terminal vectors'));
  const authorityVectors = [...Array.from(properties.authorityCharacters), ...authorities];
  for (const authority of authorityVectors) {
    safe.add(`https://${authority}${properties.componentSuffix}`);
    safe.add(`//${authority}${properties.componentSuffix}`);
    for (const value of punctuation) {
      safe.add(`https://${authority}/path${value}/private`);
      safe.add(`https://${authority}/path?value=${value}/private`);
      safe.add(`https://${authority}/path#value=${value}/private`);
      safe.add(`//${authority}/path${value}/private`);
      safe.add(`//${authority}/path?value=${value}/private`);
      safe.add(`//${authority}/path#value=${value}/private`);
    }
  }
  for (const wrapper of wrappers) {
    const wrapped = `${wrapper.opener}${properties.wrapperUrl}${wrapper.closer}`;
    safe.add(wrapped);
    safe.add(`${wrapper.opener}${properties.wrapperUrl}/private${wrapper.closer}`);
    unsafe.add(`${wrapped}/private`);
    unsafe.add(
      `${wrapper.opener}https://example.invalid/long/valid/prefix/a^b/private${wrapper.closer}`,
    );
    for (const subdelimiter of subdelimiters) {
      const candidates = [
        `https://user${subdelimiter}name@example.invalid/path?x=query#f=fragment`,
        `https://exa${subdelimiter}mple.invalid/path?x=query#f=fragment`,
        `https://example.invalid/a${subdelimiter}b?x=query#f=fragment`,
        `https://example.invalid/path?x=a${subdelimiter}b#f=fragment`,
        `https://example.invalid/path?x=query#f=a${subdelimiter}b`,
      ];
      for (const candidate of candidates) {
        safe.add(`${wrapper.opener}${candidate}${wrapper.closer}`);
      }
    }
  }
  for (const unknown of unknownCharacters) {
    unsafe.add(`https://exa${unknown}mple.invalid/private`);
    unsafe.add(`https://example.invalid/a${unknown}b/private`);
    unsafe.add(`https://example.invalid/a?x=${unknown}/private`);
    unsafe.add(`https://example.invalid/a#x=${unknown}/private`);
    unsafe.add(`https://very.long.valid.prefix.exa${unknown}mple.invalid/private`);
    unsafe.add(`https://example.invalid/long/valid/prefix/a${unknown}b/private`);
    unsafe.add(`https://example.invalid/long/valid/prefix?x=${unknown}/private`);
    unsafe.add(`https://example.invalid/long/valid/prefix#x=${unknown}/private`);
  }
  const longSemantic = terminalPathLongSemanticVectors(input);
  for (const vector of longSemantic.safe) {
    safe.add(vector.value);
  }
  for (const vector of longSemantic.unsafe) {
    unsafe.add(vector);
  }
  return Object.freeze({
    unsafe: Object.freeze([...unsafe]),
    safe: Object.freeze([...safe]),
  });
};
