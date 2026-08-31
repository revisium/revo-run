import { performance } from 'node:perf_hooks';

import type {
  AgentInvocationHandle as RuntimeInvocationHandle,
  AgentInvocationResult,
} from '@revisium/revo-agent-runtime';
import { describe, expect, it } from 'vitest';

import type { AgentTerminalResult } from '../../src/composition/agent-port.js';
import {
  sanitizeAgentResultLookup,
  sanitizeAgentTerminalResult,
  sanitizeCancelResult,
  sanitizeInvocationHandle,
} from '../../src/composition/agents/codex/codex-result-mapper.js';
import { isJsonObject, type JsonObject } from '../../src/contracts/json.js';
import {
  codexContextCase,
  expandTerminalPathContextInput,
  terminalPathComplexityParameters,
  terminalPathLongSemanticVectors,
} from '../support/codex-conformance.js';

const runtimeSuccess = (value: JsonObject): AgentInvocationResult => ({
  schemaVersion: 'agent-invocation-result/v1',
  invocationId: 'terminal-sanitizer',
  pin: {
    agentId: 'codex',
    agentVersion: 'definition-v1',
    definitionDigest: 'a'.repeat(64),
  },
  launch: { executable: '/private/codex', reportedVersion: 'test' },
  acceptedAt: '2026-08-30T00:00:00.000Z',
  startedAt: '2026-08-30T00:00:00.000Z',
  finishedAt: '2026-08-30T00:00:01.000Z',
  durationMs: 1_000,
  exit: { code: 0, signal: null },
  files: {
    directory: '/private/output',
    events: 'events.ndjson',
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    result: 'result.json',
  },
  status: 'succeeded',
  value,
});

const runtimeFailure = (message: string): AgentInvocationResult => ({
  schemaVersion: 'agent-invocation-result/v1',
  invocationId: 'terminal-sanitizer',
  pin: {
    agentId: 'codex',
    agentVersion: 'definition-v1',
    definitionDigest: 'a'.repeat(64),
  },
  launch: { executable: '/private/codex', reportedVersion: 'test' },
  acceptedAt: '2026-08-30T00:00:00.000Z',
  startedAt: '2026-08-30T00:00:00.000Z',
  finishedAt: '2026-08-30T00:00:01.000Z',
  durationMs: 1_000,
  exit: { code: 1, signal: null },
  files: {
    directory: '/private/output',
    events: 'events.ndjson',
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    result: 'result.json',
  },
  status: 'failed',
  error: { code: 'revo.agent.process_failed', message, phase: 'running', retryable: false },
});

const isGenericFailure = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || !('status' in value) || !('error' in value)) {
    return false;
  }
  const error = value.error;
  return (
    value.status === 'failed' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    error.code === 'revo.run.execution_failed' &&
    error.message === 'Agent execution failed.'
  );
};

const carrierNames = ['direct', 'lookup', 'cancel', 'handle.result', 'handle.cancel'] as const;
const unicodeCredentialKeyVectors = [
  ['joined API Kelvin key', 'apiKey'],
  ['joined access Kelvin key', 'accessKey'],
  ['joined private Kelvin key', 'privateKey'],
  ['prefixed camel Kelvin key', 'clientAPIKey'],
  ['acronym Kelvin key', 'APIKey'],
  ['dotted-I private key', 'PRİVATEKEY'],
] as const;

const legacyAsciiUpper = (value: string | undefined): boolean =>
  value !== undefined && value >= 'A' && value <= 'Z';
const legacyAsciiLower = (value: string | undefined): boolean =>
  value !== undefined && value >= 'a' && value <= 'z';
const legacyAsciiDigit = (value: string | undefined): boolean =>
  value !== undefined && value >= '0' && value <= '9';
const legacyCamelBoundary = (points: readonly string[], cursor: number): boolean =>
  legacyAsciiUpper(points[cursor]) &&
  (legacyAsciiLower(points[cursor - 1]) ||
    legacyAsciiDigit(points[cursor - 1]) ||
    (legacyAsciiUpper(points[cursor - 1]) && legacyAsciiLower(points[cursor + 1])));

const legacyKeySegments = (key: string): readonly string[] => {
  const original = Array.from(key);
  let separated = '';
  for (let cursor = 0; cursor < original.length; cursor += 1) {
    if (legacyCamelBoundary(original, cursor)) {
      separated += '_';
    }
    separated += original[cursor] ?? '';
  }
  const segments: string[] = [];
  let segment = '';
  for (const point of Array.from(separated.toLowerCase())) {
    if (legacyAsciiLower(point) || legacyAsciiDigit(point)) {
      segment += point;
      continue;
    }
    if (segment.length > 0) {
      segments.push(segment);
      segment = '';
    }
  }
  if (segment.length > 0) {
    segments.push(segment);
  }
  return segments;
};

const legacyForbiddenKey = (key: string): boolean => {
  const segments = legacyKeySegments(key);
  const joined = segments.join('');
  return (
    segments.some((segment) =>
      [
        'auth',
        'authentication',
        'authorization',
        'credential',
        'credentials',
        'env',
        'environment',
        'key',
        'keys',
        'password',
        'secret',
        'secrets',
        'token',
      ].includes(segment),
    ) ||
    [
      'auth',
      'authentication',
      'authorization',
      'credential',
      'credentials',
      'environment',
      'password',
      'secret',
      'secrets',
      'token',
      'tokens',
    ].some((suffix) => joined.endsWith(suffix)) ||
    ['accesskey', 'apikey', 'privatekey', 'secretkey'].some((infix) => joined.includes(infix))
  );
};

const productionForbiddenKey = (key: string): boolean =>
  isGenericFailure(sanitizeAgentTerminalResult(runtimeSuccess({ [key]: 'value' })));

const sanitizeAcrossCarriers = async (
  runtimeResult: AgentInvocationResult,
): Promise<
  readonly Readonly<{ carrier: (typeof carrierNames)[number]; result: AgentTerminalResult }>[]
> => {
  const lookup = sanitizeAgentResultLookup({ state: 'completed', result: runtimeResult });
  if (lookup.state !== 'completed') {
    throw new Error('Completed lookup sanitizer returned a non-completed result.');
  }
  const cancellation = sanitizeCancelResult({ state: 'already_completed', result: runtimeResult });
  if (cancellation.state !== 'already_completed') {
    throw new Error('Completed cancellation sanitizer returned a non-completed result.');
  }
  const runtimeHandle: RuntimeInvocationHandle = {
    invocationId: runtimeResult.invocationId,
    pin: runtimeResult.pin,
    result: async () => runtimeResult,
    cancel: async () => ({ state: 'already_completed', result: runtimeResult }),
  };
  const handle = sanitizeInvocationHandle(runtimeHandle);
  const handleCancellation = await handle.cancel();
  if (handleCancellation.state !== 'already_completed') {
    throw new Error('Completed handle cancellation returned a non-completed result.');
  }
  return [
    { carrier: 'direct', result: sanitizeAgentTerminalResult(runtimeResult) },
    { carrier: 'lookup', result: lookup.result },
    { carrier: 'cancel', result: cancellation.result },
    { carrier: 'handle.result', result: await handle.result() },
    { carrier: 'handle.cancel', result: handleCancellation.result },
  ];
};

const unsafeObservation = (result: AgentTerminalResult): JsonObject => ({
  status: result.status,
  code: result.status === 'failed' || result.status === 'timed_out' ? result.error.code : null,
  message:
    result.status === 'failed' || result.status === 'timed_out' ? result.error.message : null,
  valuePresent: 'value' in result,
});

const safeSuccessObservation = (result: AgentTerminalResult, source: string): JsonObject => ({
  status: result.status,
  valuePreserved: result.status === 'succeeded' && result.value.value === source,
});

const safeFailureObservation = (result: AgentTerminalResult, source: string): JsonObject => ({
  status: result.status,
  code: result.status === 'failed' || result.status === 'timed_out' ? result.error.code : null,
  messagePreserved:
    (result.status === 'failed' || result.status === 'timed_out') &&
    result.error.message === source,
});

const sizedValue = (
  targetLength: number,
  prefix: string,
  pattern: string,
  suffix: string,
): string => {
  const bodyLength = targetLength - prefix.length - suffix.length;
  if (bodyLength < pattern.length) {
    throw new Error('Terminal complexity target is too small.');
  }
  const repetitions = Math.floor(bodyLength / pattern.length);
  const remainder = bodyLength % pattern.length;
  return `${prefix}${pattern.repeat(repetitions)}${pattern.slice(0, remainder)}${suffix}`;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) {
    throw new Error('Terminal complexity sample set is empty.');
  }
  return value;
};

const measureSafeSanitizerBatch = (values: readonly string[], iterations: number): number => {
  const runtimeResults = values.map((value) => runtimeSuccess({ value }));
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const runtimeResult = runtimeResults[index % runtimeResults.length];
    if (runtimeResult === undefined) {
      throw new Error('Terminal complexity batch has no input.');
    }
    const result = sanitizeAgentTerminalResult(runtimeResult);
    if (result.status !== 'succeeded') {
      throw new Error('A valid terminal complexity input was rejected.');
    }
  }
  return performance.now() - started;
};

describe('Codex terminal sanitizer', () => {
  it.each([
    ['environment key', { nested: { environment: { safe: true } } }],
    ['camel-case secret key', { nested: { apiKey: 'value' } }],
    ['lowercase joined API credential key', { apikey: 'value' }],
    ['prefixed joined API credential key', { clientAPIKey: 'value' }],
    ['auth key', { auth: 'value' }],
    ['absolute POSIX path', { value: '/private/value' }],
    ['drive path', { value: 'C:\\private\\value' }],
    ['UNC path', { value: '\\\\server\\share' }],
    ['file URI', { value: 'file:///private/value' }],
    ['captured secret', { value: 'prefix-captured-secret-suffix' }],
  ] as const)('maps unsafe success with %s to one generic failure', (_name, value) => {
    expect(
      isGenericFailure(sanitizeAgentTerminalResult(runtimeSuccess(value), ['captured-secret'])),
    ).toBe(true);
  });

  it.each(unicodeCredentialKeyVectors)('rejects the %s Unicode lowercase sibling', (_name, key) => {
    expect(productionForbiddenKey(key)).toBe(true);
  });

  it('rejects every Unicode lowercase sibling through every terminal carrier', async () => {
    for (const [, key] of unicodeCredentialKeyVectors) {
      // oxlint-disable-next-line no-await-in-loop -- each key must traverse the stable carrier order.
      const carriers = await sanitizeAcrossCarriers(runtimeSuccess({ [key]: 'value' }));
      expect(carriers.map(({ carrier }) => carrier)).toStrictEqual(carrierNames);
      for (const carrier of carriers) {
        expect(isGenericFailure(carrier.result)).toBe(true);
      }
    }
  });

  it('matches the legacy key normalization across ASCII and the approved Unicode folds', () => {
    const ascii = Array.from({ length: 128 }, (_value, code) => String.fromCodePoint(code));
    const keys = new Set<string>(unicodeCredentialKeyVectors.map(([, key]) => key));
    for (const point of ascii) {
      keys.add(point);
      keys.add(`api${point}key`);
      keys.add(`access${point}key`);
      keys.add(`private${point}key`);
      keys.add(`client${point}APIKey`);
      keys.add(`${point}Token`);
    }
    for (const key of keys) {
      expect({ key, forbidden: productionForbiddenKey(key) }).toStrictEqual({
        key,
        forbidden: legacyForbiddenKey(key),
      });
    }
  });

  it('CTX-TERMINAL-EMBEDDED-PATHS scans success and failure text without relative-path false positives', async () => {
    const context = await codexContextCase('CTX-TERMINAL-EMBEDDED-PATHS');
    const vectors = expandTerminalPathContextInput(context.input);
    if (
      !isJsonObject(context.expected) ||
      !Array.isArray(context.expected.carriers) ||
      !isJsonObject(context.expected.unsafeObservation) ||
      !isJsonObject(context.expected.safeSuccessObservation) ||
      !isJsonObject(context.expected.safeFailureObservation) ||
      !isJsonObject(context.expected.checks)
    ) {
      throw new Error('CTX-TERMINAL-EMBEDDED-PATHS has invalid input.');
    }
    expect(carrierNames).toStrictEqual(context.expected.carriers);
    let unsafeSuccessChecks = 0;
    let unsafeFailureChecks = 0;
    let safeSuccessChecks = 0;
    let safeFailureChecks = 0;
    for (const value of vectors.unsafe) {
      // oxlint-disable-next-line no-await-in-loop -- the stable vector fixes carrier order.
      const success = await sanitizeAcrossCarriers(runtimeSuccess({ value }));
      // oxlint-disable-next-line no-await-in-loop -- the matching failure must use the same vector.
      const failure = await sanitizeAcrossCarriers(runtimeFailure(value));
      expect(success.map(({ carrier }) => carrier)).toStrictEqual(context.expected.carriers);
      expect(failure.map(({ carrier }) => carrier)).toStrictEqual(context.expected.carriers);
      for (const carrier of success) {
        expect(unsafeObservation(carrier.result)).toStrictEqual(context.expected.unsafeObservation);
        unsafeSuccessChecks += 1;
      }
      for (const carrier of failure) {
        expect(unsafeObservation(carrier.result)).toStrictEqual(context.expected.unsafeObservation);
        unsafeFailureChecks += 1;
      }
    }
    for (const value of vectors.safe) {
      // oxlint-disable-next-line no-await-in-loop -- the stable vector fixes carrier order.
      const success = await sanitizeAcrossCarriers(runtimeSuccess({ value }));
      // oxlint-disable-next-line no-await-in-loop -- the matching failure must use the same vector.
      const failure = await sanitizeAcrossCarriers(runtimeFailure(value));
      expect(success.map(({ carrier }) => carrier)).toStrictEqual(context.expected.carriers);
      expect(failure.map(({ carrier }) => carrier)).toStrictEqual(context.expected.carriers);
      for (const carrier of success) {
        expect(safeSuccessObservation(carrier.result, value)).toStrictEqual(
          context.expected.safeSuccessObservation,
        );
        safeSuccessChecks += 1;
      }
      for (const carrier of failure) {
        expect(safeFailureObservation(carrier.result, value)).toStrictEqual(
          context.expected.safeFailureObservation,
        );
        safeFailureChecks += 1;
      }
    }
    expect({
      unsafeVectors: vectors.unsafe.length,
      safeVectors: vectors.safe.length,
      carriers: carrierNames.length,
      unsafeSuccess: unsafeSuccessChecks,
      unsafeFailure: unsafeFailureChecks,
      safeSuccess: safeSuccessChecks,
      safeFailure: safeFailureChecks,
    }).toStrictEqual(context.expected.checks);
  });

  it('CTX-TERMINAL-EMBEDDED-PATHS selects the final valid ambiguous wrapper endpoint', async () => {
    const context = await codexContextCase('CTX-TERMINAL-EMBEDDED-PATHS');
    const vectors = terminalPathLongSemanticVectors(context.input);
    if (!isJsonObject(context.expected) || !isJsonObject(context.expected.complexity)) {
      throw new Error('CTX-TERMINAL-EMBEDDED-PATHS has invalid complexity expectations.');
    }
    const selectedEndpoints: string[] = [];
    for (const vector of vectors.safe) {
      const result = sanitizeAgentTerminalResult(runtimeSuccess({ value: vector.value }));
      if (result.status === 'succeeded') {
        selectedEndpoints.push(vector.id);
      }
    }
    for (const value of vectors.unsafe) {
      expect(isGenericFailure(sanitizeAgentTerminalResult(runtimeSuccess({ value })))).toBe(true);
    }
    expect(selectedEndpoints).toStrictEqual(context.expected.complexity.selectedEndpoints);
  });

  it('CTX-TERMINAL-EMBEDDED-PATHS keeps equal-byte ambiguous-wrapper work linear', async () => {
    const context = await codexContextCase('CTX-TERMINAL-EMBEDDED-PATHS');
    const parameters = terminalPathComplexityParameters(context.input);
    if (!isJsonObject(context.expected) || !isJsonObject(context.expected.complexity)) {
      throw new Error('CTX-TERMINAL-EMBEDDED-PATHS has invalid complexity expectations.');
    }
    const budget = parameters.equalByteBudget;
    const buildInputs = (bytes: number): readonly string[] => [
      sizedValue(bytes, "'https://example.invalid/", parameters.apostrophePattern, "tail'"),
      sizedValue(bytes, '(https://example.invalid/', parameters.parenthesisPattern, 'tail)'),
    ];
    const small = buildInputs(budget.smallBytes);
    const large = buildInputs(budget.largeBytes);
    measureSafeSanitizerBatch(small, 2);
    measureSafeSanitizerBatch(large, 2);
    const smallSamples = Array.from({ length: budget.samples }, () =>
      measureSafeSanitizerBatch(small, budget.smallIterations),
    );
    const largeSamples = Array.from({ length: budget.samples }, () =>
      measureSafeSanitizerBatch(large, budget.largeIterations),
    );
    const smallMedian = median(smallSamples);
    const largeMedian = median(largeSamples);
    const equalByteBudgetComparable =
      largeMedian <= smallMedian * budget.ratioCeiling + budget.fixedAllowanceMs;
    expect({ equalByteBudgetComparable }).toStrictEqual({
      equalByteBudgetComparable: context.expected.complexity.equalByteBudgetComparable,
    });
  });

  it('CTX-TERMINAL-EMBEDDED-PATHS completes near-limit valid and malformed tails', async () => {
    const context = await codexContextCase('CTX-TERMINAL-EMBEDDED-PATHS');
    const parameters = terminalPathComplexityParameters(context.input);
    if (!isJsonObject(context.expected) || !isJsonObject(context.expected.complexity)) {
      throw new Error('CTX-TERMINAL-EMBEDDED-PATHS has invalid complexity expectations.');
    }
    const valid = sizedValue(
      parameters.nearLimit.bytes,
      "'https://example.invalid/",
      parameters.apostrophePattern,
      "tail'",
    );
    const malformed = sizedValue(
      parameters.nearLimit.bytes,
      'https://example.invalid/',
      'a/b;!+,',
      '^/private',
    );
    const started = performance.now();
    const validResult = sanitizeAgentTerminalResult(runtimeSuccess({ value: valid }));
    const malformedResult = sanitizeAgentTerminalResult(runtimeSuccess({ value: malformed }));
    const elapsed = performance.now() - started;
    expect({
      nearLimitValid: validResult.status,
      nearLimitMalformed: malformedResult.status,
    }).toStrictEqual({
      nearLimitValid: context.expected.complexity.nearLimitValid,
      nearLimitMalformed: context.expected.complexity.nearLimitMalformed,
    });
    expect(elapsed).toBeLessThanOrEqual(parameters.nearLimit.timeoutMs);
  }, 15_000);

  it('CTX-TERMINAL-ACRONYMS maps normalized credential keys to one generic failure', async () => {
    const context = await codexContextCase('CTX-TERMINAL-ACRONYMS');
    if (
      !isJsonObject(context.input) ||
      !Array.isArray(context.input.variants) ||
      !context.input.variants.every(isJsonObject)
    ) {
      throw new Error('CTX-TERMINAL-ACRONYMS has invalid input.');
    }
    for (const value of context.input.variants) {
      const result = sanitizeAgentTerminalResult(runtimeSuccess(value));
      expect({
        status: result.status,
        code: result.status === 'failed' ? result.error.code : null,
        valuePresent: 'value' in result,
      }).toStrictEqual(context.expected);
    }
  });

  it.each(['https:///private/x', '///private/x', '//', 'profile:/relative-looking'])(
    'rejects malformed URL authority or colon-resumed absolute text: %s',
    (value) => {
      expect(
        unsafeObservation(sanitizeAgentTerminalResult(runtimeSuccess({ value }))),
      ).toStrictEqual({
        status: 'failed',
        code: 'revo.run.execution_failed',
        message: 'Agent execution failed.',
        valuePresent: false,
      });
    },
  );

  it.each(['//example.invalid/path', 'abc/private', 'dir-/file'])(
    'preserves valid protocol-relative URLs and already-relative atoms: %s',
    (value) => {
      expect(
        safeSuccessObservation(sanitizeAgentTerminalResult(runtimeSuccess({ value })), value),
      ).toStrictEqual({ status: 'succeeded', valuePreserved: true });
    },
  );

  it('preserves safe bounded JSON and recursively freezes the clone', () => {
    const source = { result: [{ ok: true, label: 'safe/value' }] };
    const result = sanitizeAgentTerminalResult(runtimeSuccess(source));

    expect(result).toMatchObject({ status: 'succeeded', value: source });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== 'succeeded') {
      throw new Error('Expected a success result.');
    }
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.result)).toBe(true);
    const nested = result.value.result;
    if (!Array.isArray(nested) || nested[0] === undefined) {
      throw new Error('Expected the nested result array.');
    }
    expect(Object.isFrozen(nested[0])).toBe(true);
  });

  it('uses the same sanitizer for lookup, cancel-already-completed, and handle methods', async () => {
    const unsafe = runtimeSuccess({ value: 'provider failed at /private/output/result.json' });
    const lookup = sanitizeAgentResultLookup({ state: 'completed', result: unsafe });
    expect(isGenericFailure(lookup.state === 'completed' ? lookup.result : undefined)).toBe(true);
    const cancelled = sanitizeCancelResult({ state: 'already_completed', result: unsafe });
    expect(
      isGenericFailure(cancelled.state === 'already_completed' ? cancelled.result : undefined),
    ).toBe(true);
    const runtimeHandle: RuntimeInvocationHandle = {
      invocationId: unsafe.invocationId,
      pin: unsafe.pin,
      result: async () => unsafe,
      cancel: async () => ({ state: 'already_completed', result: unsafe }),
    };
    const handle = sanitizeInvocationHandle(runtimeHandle);
    expect(isGenericFailure(await handle.result())).toBe(true);
    const handleCancellation = await handle.cancel();
    expect(
      isGenericFailure(
        handleCancellation.state === 'already_completed' ? handleCancellation.result : undefined,
      ),
    ).toBe(true);
  });
});
