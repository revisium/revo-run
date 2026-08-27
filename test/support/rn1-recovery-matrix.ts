import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect } from 'vitest';

type JsonRecord = Readonly<Record<string, unknown>>;

type RecoveryCountCategory = 'calls' | 'events';

interface RecoveryCounts {
  readonly calls: Readonly<{
    readonly execute: number;
    readonly reconcile: number;
    readonly cancel: number;
  }>;
  readonly events: Readonly<{ readonly script: number; readonly kernel: number }>;
}

export interface RecoveryMatrixScenario {
  readonly id: string;
  readonly input: JsonRecord;
  readonly expected: JsonRecord;
  readonly negative: JsonRecord;
}

export interface RecoveryObservation extends RecoveryCounts {
  readonly state: string;
  readonly status: string;
  /** Runtime proofs that every forbidden transition did not occur. */
  readonly prohibited: JsonRecord;
}

export type CancellationVariant =
  | 'acknowledged'
  | 'alreadyTerminal'
  | 'uncertain'
  | 'notFound'
  | 'unknown';

export interface CanonicalCancellationMapping {
  readonly variant: CancellationVariant;
  readonly action: string;
  readonly result: JsonRecord;
  readonly expected: JsonRecord;
}

export interface CanonicalCancellationAttempt {
  readonly executionId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly input: JsonRecord;
}

export interface CancellationObservation {
  /** The result observed at the public cancel boundary, before late settlement. */
  readonly result: JsonRecord;
  /** Actual run/kernel observations, keyed exactly like the fixture's expected record. */
  readonly expected: JsonRecord;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredRecord = (value: unknown, name: string): JsonRecord => {
  if (!isRecord(value)) {
    throw new Error(`RN1 recovery matrix has no ${name} record.`);
  }
  return value;
};

const requiredString = (value: JsonRecord, name: string): string => {
  if (typeof value[name] !== 'string') {
    throw new Error(`RN1 recovery matrix has no ${name} string.`);
  }
  return value[name];
};

const requiredCount = (value: JsonRecord, name: string): number => {
  const count = value[name];
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`RN1 recovery matrix has no ${name} count.`);
  }
  return count;
};

const requiredBoolean = (value: JsonRecord, name: string): boolean => {
  if (typeof value[name] !== 'boolean') {
    throw new Error(`RN1 recovery matrix has no ${name} boolean.`);
  }
  return value[name];
};

const requiredCancellationVariant = (value: unknown): CancellationVariant => {
  if (
    value !== 'acknowledged' &&
    value !== 'alreadyTerminal' &&
    value !== 'uncertain' &&
    value !== 'notFound' &&
    value !== 'unknown'
  ) {
    throw new Error('Canonical cancellation mapping has an invalid variant.');
  }
  return value;
};

const readPinnedJson = (url: URL, manifestPath: string): unknown => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL('../contracts/fixtures/governing-artifacts.json', import.meta.url),
      'utf8',
    ),
  );
  const artifacts = requiredRecord(
    requiredRecord(manifest, 'governing artifact manifest').artifacts,
    'artifacts',
  );
  const expectedDigest = requiredString(artifacts, manifestPath);
  const source = readFileSync(url, 'utf8');
  const actualDigest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
  if (actualDigest !== expectedDigest) {
    throw new Error(`RN1 recovery fixture ${manifestPath} does not match its governing digest.`);
  }
  return JSON.parse(source);
};

const parseRecoveryScenarios = (): readonly RecoveryMatrixScenario[] => {
  const fixture = readPinnedJson(
    new URL('../integration/fixtures/recovery/d1-d9.json', import.meta.url),
    'integration/recovery/d1-d9.json',
  );
  const root = requiredRecord(fixture, 'root');
  if (root.schemaVersion !== 'rn1-durable-recovery-matrix/v1' || !Array.isArray(root.scenarios)) {
    throw new Error('RN1 recovery matrix has an invalid closed shape.');
  }
  return root.scenarios.map((value): RecoveryMatrixScenario => {
    const scenario = requiredRecord(value, 'scenario');
    return {
      id: requiredString(scenario, 'id'),
      input: requiredRecord(scenario.input, 'scenario input'),
      expected: requiredRecord(scenario.expected, 'scenario expected'),
      negative: requiredRecord(scenario.negative, 'scenario negative'),
    };
  });
};

const parseCancellationFixture = (): Readonly<{
  readonly attempt: CanonicalCancellationAttempt;
  readonly mappings: readonly CanonicalCancellationMapping[];
}> => {
  const fixture = readPinnedJson(
    new URL('../contracts/fixtures/scripts/cancellation-result-mapping.json', import.meta.url),
    'scripts/cancellation-result-mapping.json',
  );
  const root = requiredRecord(fixture, 'cancellation root');
  if (
    root.schemaVersion !== 'rn1-script-cancellation-mapping/v1' ||
    !Array.isArray(root.mappings)
  ) {
    throw new Error('Canonical cancellation mapping has an invalid closed shape.');
  }
  const attempt = requiredRecord(root.attempt, 'cancellation attempt');
  const attemptOrdinal = requiredCount(attempt, 'attemptOrdinal');
  if (attemptOrdinal < 1) {
    throw new Error('Canonical cancellation mapping has an invalid attempt ordinal.');
  }
  return {
    attempt: {
      executionId: requiredString(attempt, 'executionId'),
      attemptId: requiredString(attempt, 'attemptId'),
      attemptOrdinal,
      input: requiredRecord(attempt.input, 'attempt input'),
    },
    mappings: root.mappings.map((value): CanonicalCancellationMapping => {
      const mapping = requiredRecord(value, 'cancellation mapping');
      return {
        variant: requiredCancellationVariant(mapping.variant),
        action: requiredString(mapping, 'action'),
        result: requiredRecord(mapping.result, 'cancellation result'),
        expected: requiredRecord(mapping.expected, 'cancellation expected'),
      };
    }),
  };
};

const scenarios = parseRecoveryScenarios();
const cancellationFixture = parseCancellationFixture();

export const recoveryScenario = (id: string): RecoveryMatrixScenario => {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`RN1 recovery matrix has no ${id} scenario.`);
  }
  return scenario;
};

export const cancellationMappings = cancellationFixture.mappings;
export const cancellationAttempt = cancellationFixture.attempt;

export const cancellationMapping = (variant: CancellationVariant): CanonicalCancellationMapping => {
  const mapping = cancellationMappings.find((candidate) => candidate.variant === variant);
  if (mapping === undefined) {
    throw new Error(`Canonical cancellation mapping has no ${variant} row.`);
  }
  return mapping;
};

export const recoveryExpectedCount = (
  scenario: RecoveryMatrixScenario,
  category: RecoveryCountCategory,
  key: string,
): number =>
  requiredCount(requiredRecord(scenario.expected[category], `${scenario.id} ${category}`), key);

export const recoveryExpectedString = (scenario: RecoveryMatrixScenario, key: string): string =>
  requiredString(scenario.expected, key);

export const recoveryNegative = (scenario: RecoveryMatrixScenario, key: string): false => {
  if (scenario.negative[key] !== false) {
    throw new Error(`RN1 recovery matrix has no false ${scenario.id} ${key} prohibition.`);
  }
  return false;
};

/**
 * Binds a D1–D9 fixture row to runtime evidence. A test cannot merely prove
 * that the fixture says `false`: it must pass the matching observed transition.
 */
export const assertRecoveryObservation = (
  scenario: RecoveryMatrixScenario,
  observation: RecoveryObservation,
): void => {
  expect(observation).toStrictEqual({
    state: recoveryExpectedString(scenario, 'state'),
    status: recoveryExpectedString(scenario, 'status'),
    events: {
      script: recoveryExpectedCount(scenario, 'events', 'script'),
      kernel: recoveryExpectedCount(scenario, 'events', 'kernel'),
    },
    calls: {
      execute: recoveryExpectedCount(scenario, 'calls', 'execute'),
      reconcile: recoveryExpectedCount(scenario, 'calls', 'reconcile'),
      cancel: recoveryExpectedCount(scenario, 'calls', 'cancel'),
    },
    prohibited: scenario.negative,
  });
};

/** Binds all cancellation mapping fields to the public boundary observation. */
export const assertCancellationObservation = (
  mapping: CanonicalCancellationMapping,
  observation: CancellationObservation,
): void => {
  expect(observation.result).toStrictEqual(mapping.result);
  expect(observation.expected).toStrictEqual(mapping.expected);
};

export const cancellationExpectedBoolean = (
  mapping: CanonicalCancellationMapping,
  key: string,
): boolean => requiredBoolean(mapping.expected, key);

export const cancellationExpectedCount = (
  mapping: CanonicalCancellationMapping,
  key: string,
): number => requiredCount(mapping.expected, key);

export const cancellationExpectedString = (
  mapping: CanonicalCancellationMapping,
  key: string,
): string => requiredString(mapping.expected, key);

export const cancellationExpectedRecord = (
  mapping: CanonicalCancellationMapping,
  key: string,
): JsonRecord => requiredRecord(mapping.expected[key], key);
