import { describe, expect, expectTypeOf, test } from 'vitest';

import type { ExecutorUnavailableFault } from '../../src/errors/index.js';
import {
  canonicalizeJson,
  snapshotExecutorConfiguration,
  snapshotExecutorInvocationSnapshot,
  snapshotExecutorOutput,
  snapshotExecutorOutputs,
  verifyExecutorBinding,
} from '../../src/policy/index.js';
import type {
  ExecutorCancelResult,
  ExecutorExecuteResult,
  ExecutorReconcileResult,
  ExecutorResolution,
  ResolvedExecutor,
} from '../../src/ports/index.js';
import type {
  ExecutorBindingMismatchReason,
  ExecutorBindingVerificationInput,
} from '../../src/spec/index.js';

const pin = { adapterId: 'adapter', digest: 'contract', revision: '1' };
const attemptReference = {
  activationId: 'activation',
  attemptId: 'attempt',
  dispatchIdempotencyKey: 'dispatch',
  nodeInstanceId: 'node-instance',
  nodeKey: 'node',
  runId: 'run',
};

const nestedArray = (depth: number): unknown => {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
};

const invocationFor = (overrides: Readonly<Record<string, unknown>> = {}): unknown => {
  const configuration = {};
  return {
    activationContext: null,
    attempt: attemptReference,
    executorConfiguration: configuration,
    executorConfigurationDigest: snapshotExecutorConfiguration(configuration).digest,
    executorContractPin: pin,
    runInput: null,
    ...overrides,
  };
};

const outputFor = (value: unknown, name = 'output'): unknown => ({
  name,
  payload: { kind: 'json', value },
});

const expectRecursivelyFrozen = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) expectRecursivelyFrozen(descriptor.value);
  }
};

describe('executor entrypoint canonical bounds', () => {
  test('enforces output-name UTF-8 bounds and exact string uniqueness', () => {
    const maximumName = '😀'.repeat(64);
    expect(snapshotExecutorOutput(outputFor(null, maximumName)).name).toBe(maximumName);
    expect(() => snapshotExecutorOutput(outputFor(null, `${maximumName}x`))).toThrow(RangeError);

    expect(
      snapshotExecutorOutputs([
        outputFor(null, 'Name'),
        outputFor(null, 'name'),
        outputFor(null, '\u00e9'),
        outputFor(null, 'e\u0301'),
      ]),
    ).toHaveLength(4);
    expect(() =>
      snapshotExecutorOutputs([outputFor(null, '\u00e9'), outputFor(null, '\u00e9')]),
    ).toThrow(TypeError);
  });

  test('enforces depth 64/65 at invocation and complete-output entrypoints', () => {
    expect(() =>
      snapshotExecutorInvocationSnapshot(invocationFor({ runInput: nestedArray(63) })),
    ).not.toThrow();
    expect(() =>
      snapshotExecutorInvocationSnapshot(invocationFor({ runInput: nestedArray(64) })),
    ).toThrowError(new RangeError('Canonical JSON input exceeds the maximum depth of 64.'));

    expect(() => snapshotExecutorOutputs([outputFor(nestedArray(61))])).not.toThrow();
    expect(() => snapshotExecutorOutputs([outputFor(nestedArray(62))])).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum depth of 64.'),
    );
  });

  test('enforces 65,536/65,537 aggregate members at both entrypoints', () => {
    const exactConfiguration = Array.from({ length: 65_521 }, () => null);
    const exactDigest = snapshotExecutorConfiguration(exactConfiguration).digest;
    expect(() =>
      snapshotExecutorInvocationSnapshot(
        invocationFor({
          executorConfiguration: exactConfiguration,
          executorConfigurationDigest: exactDigest,
        }),
      ),
    ).not.toThrow();

    const oversizedConfiguration = [...exactConfiguration, null];
    const oversizedDigest = snapshotExecutorConfiguration(oversizedConfiguration).digest;
    expect(() =>
      snapshotExecutorInvocationSnapshot(
        invocationFor({
          executorConfiguration: oversizedConfiguration,
          executorConfigurationDigest: oversizedDigest,
        }),
      ),
    ).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum member count of 65536.'),
    );

    expect(() =>
      snapshotExecutorOutputs([outputFor(Array.from({ length: 65_531 }, () => null))]),
    ).not.toThrow();
    expect(() =>
      snapshotExecutorOutputs([outputFor(Array.from({ length: 65_532 }, () => null))]),
    ).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum member count of 65536.'),
    );
  });

  test('enforces exact 1 MiB/+1 canonical UTF-8 size at both entrypoints', () => {
    const invocationBase = invocationFor({ runInput: '' });
    const invocationPadding =
      1_048_576 - Buffer.byteLength(canonicalizeJson(invocationBase), 'utf8');
    const exactInvocation = invocationFor({ runInput: 'x'.repeat(invocationPadding) });
    expect(
      Buffer.byteLength(
        canonicalizeJson(snapshotExecutorInvocationSnapshot(exactInvocation)),
        'utf8',
      ),
    ).toBe(1_048_576);
    expect(() =>
      snapshotExecutorInvocationSnapshot(
        invocationFor({ runInput: 'x'.repeat(invocationPadding + 1) }),
      ),
    ).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum UTF-8 size of 1048576 bytes.'),
    );

    const outputsBase = [outputFor('')];
    const outputsPadding = 1_048_576 - Buffer.byteLength(canonicalizeJson(outputsBase), 'utf8');
    const exactOutputs = snapshotExecutorOutputs([outputFor('x'.repeat(outputsPadding))]);
    expect(Buffer.byteLength(canonicalizeJson(exactOutputs), 'utf8')).toBe(1_048_576);
    expect(() => snapshotExecutorOutputs([outputFor('x'.repeat(outputsPadding + 1))])).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum UTF-8 size of 1048576 bytes.'),
    );
  });
});

describe('executor hostile input rejection', () => {
  const sparse: unknown[] = [];
  sparse[1] = true;
  const customArray: unknown[] = [];
  const customArrayPrototype: object = {};
  Object.setPrototypeOf(customArrayPrototype, Array.prototype);
  Object.setPrototypeOf(customArray, customArrayPrototype);
  const customRecord: Record<string, unknown> = { value: true };
  Object.setPrototypeOf(customRecord, { inherited: true });
  const ownToJson = { toJSON: () => null };
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  let getterCalls = 0;
  const nestedGetter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return true;
    },
  });

  test.each([
    nestedGetter,
    customRecord,
    ownToJson,
    cycle,
    sparse,
    customArray,
    undefined,
    Symbol('unsupported'),
    () => undefined,
    1n,
  ])('rejects hostile invocation JSON %#', (hostile) => {
    expect(() => snapshotExecutorInvocationSnapshot(invocationFor({ runInput: hostile }))).toThrow(
      TypeError,
    );
  });

  test.each([
    nestedGetter,
    customRecord,
    ownToJson,
    cycle,
    sparse,
    customArray,
    undefined,
    Symbol('unsupported'),
    () => undefined,
    1n,
  ])('rejects hostile output JSON %#', (hostile) => {
    expect(() => snapshotExecutorOutputs([outputFor(hostile)])).toThrow(TypeError);
  });

  test('does not invoke hostile nested getters', () => {
    expect(getterCalls).toBe(0);
  });
});

describe('executor verification closure and precedence', () => {
  const configuration = { nested: { value: true } };
  const digest = snapshotExecutorConfiguration(configuration).digest;
  const valid = {
    attempt: {
      executorConfigurationDigest: digest,
      executorContractPin: pin,
    },
    binding: {
      configuration,
      configurationDigest: digest,
      executor: pin,
    },
    resolvedExecutorContractPin: pin,
  } satisfies ExecutorBindingVerificationInput;

  interface MismatchFixture {
    readonly reason: ExecutorBindingMismatchReason;
    readonly apply: (input: ExecutorBindingVerificationInput) => ExecutorBindingVerificationInput;
    readonly isPresent: (input: ExecutorBindingVerificationInput) => boolean;
  }

  const mismatches: readonly MismatchFixture[] = [
    {
      apply: (input) => ({
        ...input,
        binding: { ...input.binding, configurationDigest: `sha256:${'0'.repeat(64)}` },
      }),
      isPresent: (input) =>
        input.binding.configurationDigest !==
        snapshotExecutorConfiguration(input.binding.configuration).digest,
      reason: 'binding_configuration_digest_mismatch',
    },
    {
      apply: (input) => ({
        ...input,
        attempt: {
          ...input.attempt,
          executorContractPin: { ...input.attempt.executorContractPin, adapterId: 'other' },
        },
      }),
      isPresent: (input) =>
        input.attempt.executorContractPin.adapterId !== input.binding.executor.adapterId,
      reason: 'attempt_adapter_id_mismatch',
    },
    {
      apply: (input) => ({
        ...input,
        attempt: {
          ...input.attempt,
          executorContractPin: { ...input.attempt.executorContractPin, revision: 'other' },
        },
      }),
      isPresent: (input) =>
        input.attempt.executorContractPin.revision !== input.binding.executor.revision,
      reason: 'attempt_revision_mismatch',
    },
    {
      apply: (input) => ({
        ...input,
        attempt: {
          ...input.attempt,
          executorContractPin: { ...input.attempt.executorContractPin, digest: 'other' },
        },
      }),
      isPresent: (input) =>
        input.attempt.executorContractPin.digest !== input.binding.executor.digest,
      reason: 'attempt_contract_digest_mismatch',
    },
    {
      apply: (input) => ({
        ...input,
        attempt: {
          ...input.attempt,
          executorConfigurationDigest: `sha256:${'1'.repeat(64)}`,
        },
      }),
      isPresent: (input) =>
        input.attempt.executorConfigurationDigest !== input.binding.configurationDigest,
      reason: 'attempt_configuration_digest_mismatch',
    },
    {
      apply: (input) => ({
        ...input,
        resolvedExecutorContractPin: {
          ...input.resolvedExecutorContractPin,
          adapterId: 'other',
        },
      }),
      isPresent: (input) =>
        input.resolvedExecutorContractPin.adapterId !== input.binding.executor.adapterId,
      reason: 'resolved_adapter_id_mismatch',
    },
    {
      apply: (input) => ({
        ...input,
        resolvedExecutorContractPin: {
          ...input.resolvedExecutorContractPin,
          revision: 'other',
        },
      }),
      isPresent: (input) =>
        input.resolvedExecutorContractPin.revision !== input.binding.executor.revision,
      reason: 'resolved_revision_mismatch',
    },
    {
      apply: (input) => ({
        ...input,
        resolvedExecutorContractPin: {
          ...input.resolvedExecutorContractPin,
          digest: 'other',
        },
      }),
      isPresent: (input) =>
        input.resolvedExecutorContractPin.digest !== input.binding.executor.digest,
      reason: 'resolved_contract_digest_mismatch',
    },
  ];

  const precedencePairs: {
    readonly earlier: MismatchFixture;
    readonly later: MismatchFixture;
  }[] = [];
  for (let earlier = 0; earlier < mismatches.length; earlier += 1) {
    for (let later = earlier + 1; later < mismatches.length; later += 1) {
      const earlierMismatch = mismatches[earlier];
      const laterMismatch = mismatches[later];
      if (!earlierMismatch || !laterMismatch) {
        throw new TypeError('Expected mismatch fixtures.');
      }
      precedencePairs.push({ earlier: earlierMismatch, later: laterMismatch });
    }
  }

  test('accepts omitted idempotence in the raw type and rejects non-boolean values', () => {
    const raw: ExecutorBindingVerificationInput = valid;
    expect(verifyExecutorBinding(raw)).toMatchObject({
      evidence: { idempotentExecution: false },
      kind: 'verified',
    });
    expectTypeOf<string>().not.toMatchTypeOf<
      ExecutorBindingVerificationInput['binding']['idempotentExecution']
    >();
    expect(() =>
      verifyExecutorBinding({
        ...valid,
        binding: { ...valid.binding, idempotentExecution: 'true' },
      }),
    ).toThrow(TypeError);
  });

  test.each(precedencePairs)(
    'returns $earlier.reason before $later.reason when both axes are present',
    ({ earlier, later }) => {
      const withEarlierMismatch = earlier.apply(valid);
      const withBothMismatches = later.apply(withEarlierMismatch);

      expect(earlier.isPresent(withBothMismatches)).toBe(true);
      expect(later.isPresent(withBothMismatches)).toBe(true);
      expect(verifyExecutorBinding(withEarlierMismatch)).toEqual({
        kind: 'mismatch',
        reason: earlier.reason,
      });
      expect(verifyExecutorBinding(later.apply(valid))).toEqual({
        kind: 'mismatch',
        reason: later.reason,
      });
      expect(verifyExecutorBinding(withBothMismatches)).toEqual({
        kind: 'mismatch',
        reason: earlier.reason,
      });
    },
  );

  test('copies and recursively freezes configuration and every pin without aliases', () => {
    const bindingPin = { ...pin };
    const attemptPin = { ...pin };
    const resolvedPin = { ...pin };
    const sourceConfiguration = { nested: { value: true } };
    const sourceDigest = snapshotExecutorConfiguration(sourceConfiguration).digest;
    const result = verifyExecutorBinding({
      attempt: {
        executorConfigurationDigest: sourceDigest,
        executorContractPin: attemptPin,
      },
      binding: {
        configuration: sourceConfiguration,
        configurationDigest: sourceDigest,
        executor: bindingPin,
        idempotentExecution: true,
      },
      resolvedExecutorContractPin: resolvedPin,
    });
    if (result.kind !== 'verified') throw new TypeError('Expected verified evidence.');

    sourceConfiguration.nested.value = false;
    bindingPin.adapterId = 'changed-binding';
    attemptPin.revision = 'changed-attempt';
    resolvedPin.digest = 'changed-resolved';
    expect(result.evidence.executorConfiguration).toEqual({ nested: { value: true } });
    expect(result.evidence.executorContractPin).toEqual(pin);
    expectRecursivelyFrozen(result);
  });

  const verificationCustomRecord: Record<string, unknown> = { value: true };
  Object.setPrototypeOf(verificationCustomRecord, { hostile: true });
  const verificationCycle: { self?: unknown } = {};
  verificationCycle.self = verificationCycle;
  const verificationSparse: unknown[] = [];
  verificationSparse[1] = true;
  const verificationCustomArray: unknown[] = [];
  const verificationCustomArrayPrototype: object = {};
  Object.setPrototypeOf(verificationCustomArrayPrototype, Array.prototype);
  Object.setPrototypeOf(verificationCustomArray, verificationCustomArrayPrototype);
  let verificationGetterCalls = 0;
  const verificationGetter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => {
      verificationGetterCalls += 1;
      return true;
    },
  });

  test.each([
    Object.defineProperty({}, 'binding', { enumerable: true, get: () => valid.binding }),
    { ...valid, binding: { ...valid.binding, configuration: verificationCustomRecord } },
    { ...valid, binding: { ...valid.binding, configuration: { toJSON: () => null } } },
    { ...valid, binding: { ...valid.binding, configuration: verificationCycle } },
    { ...valid, binding: { ...valid.binding, configuration: verificationSparse } },
    { ...valid, binding: { ...valid.binding, configuration: verificationCustomArray } },
    { ...valid, binding: { ...valid.binding, configuration: verificationGetter } },
    { ...valid, binding: { ...valid.binding, configuration: undefined } },
    { ...valid, binding: { ...valid.binding, configuration: Symbol('unsupported') } },
  ])('rejects hostile verification input %#', (hostile) => {
    expect(() => verifyExecutorBinding(hostile)).toThrow(TypeError);
  });

  test('does not invoke verification configuration getters', () => {
    expect(verificationGetterCalls).toBe(0);
  });
});

test('executor port result and capability types remain closed', () => {
  const executeOnly: ResolvedExecutor = {
    contractPin: pin,
    async execute(): Promise<ExecutorExecuteResult> {
      return { kind: 'cancelled' };
    },
  };
  const withReconcileOnly: ResolvedExecutor = {
    ...executeOnly,
    async reconcile(): Promise<ExecutorReconcileResult> {
      return { kind: 'not_found' };
    },
  };
  const withCancelOnly: ResolvedExecutor = {
    ...executeOnly,
    async cancel(): Promise<ExecutorCancelResult> {
      return { kind: 'unconfirmed' };
    },
  };
  const reconcileOnlyObservation: ExecutorReconcileResult = { kind: 'not_found' };
  const cancelResult: ExecutorCancelResult = { kind: 'unsupported' };
  const unavailableFault: ExecutorUnavailableFault = {
    code: 'EXECUTOR_UNAVAILABLE',
    message: 'Unavailable.',
  };
  const unavailable: ExecutorResolution = { fault: unavailableFault, kind: 'unavailable' };

  expect(Object.hasOwn(executeOnly, 'reconcile')).toBe(false);
  expect(Object.hasOwn(executeOnly, 'cancel')).toBe(false);
  expect(Object.hasOwn(withReconcileOnly, 'reconcile')).toBe(true);
  expect(Object.hasOwn(withReconcileOnly, 'cancel')).toBe(false);
  expect(Object.hasOwn(withCancelOnly, 'cancel')).toBe(true);
  expect(Object.hasOwn(withCancelOnly, 'reconcile')).toBe(false);
  expect(reconcileOnlyObservation.kind).toBe('not_found');
  expect(cancelResult.kind).toBe('unsupported');
  expect(unavailable.kind).toBe('unavailable');
  expectTypeOf<ResolvedExecutor['execute']>().toBeFunction();
});
