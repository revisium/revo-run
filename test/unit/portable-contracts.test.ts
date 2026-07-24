import { describe, expect, expectTypeOf, test } from 'vitest';

import type {
  ExecutionPlanPin,
  ExecutorContractPin,
  LeasePolicy,
  ProcessLocalConcurrencyPolicy,
  RetryPolicy,
  RunArtifactReference,
  RunConflict,
  RunExecutionPlanDocument,
  RunExecutionPlanExecutorBinding,
  RunFault,
  RunOutputPayload,
  TimeoutPolicy,
} from '../../src/index.js';
import {
  canonicalizeJson,
  snapshotExecutionPlanPin,
  snapshotExecutorConfiguration,
  snapshotExecutorContractPin,
  snapshotLeasePolicy,
  snapshotProcessLocalConcurrencyPolicy,
  snapshotRetryPolicy,
  snapshotRunArtifactReference,
  snapshotRunExecutionPlanDocument,
  snapshotRunFaultMessage,
  snapshotRunOutputPayload,
  snapshotTimeoutPolicy,
} from '../../src/policy/index.js';

const expectRecursivelyFrozen = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) expectRecursivelyFrozen(descriptor.value);
  }
};

const isReadonlyUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const expectPortableArrayBehavior = (value: unknown): void => {
  if (!isReadonlyUnknownArray(value)) {
    throw new TypeError('Expected a portable readonly array.');
  }
  expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
  expect(Object.isFrozen(value)).toBe(true);
  expect([...value]).toEqual([1, 2]);
  const visited: unknown[] = [];
  value.forEach((item) => visited.push(item));
  expect(visited).toEqual([1, 2]);
  expect(Array.from(value[Symbol.iterator]())).toEqual([1, 2]);
};

const retryPolicy = {
  backoffMultiplier: 2,
  initialBackoffMs: 100,
  maximumAttempts: 3,
  maximumBackoffMs: 10_000,
};

const timeoutPolicy = {
  cancellationTimeoutMs: 10_000,
  executionTimeoutMs: 60_000,
  reconciliationTimeoutMs: 30_000,
};

describe('portable exact pins and executor configuration', () => {
  test('copies bounded exact pins while keeping the plan digest opaque', () => {
    const planInput = {
      digest: 'host-owned:opaque/value',
      id: 'release-plan',
      revision: 'revision-7',
    };
    const executorInput = {
      adapterId: 'agent-adapter',
      digest: 'contract:v3/opaque',
      revision: '3',
    };

    const plan = snapshotExecutionPlanPin(planInput);
    const executor = snapshotExecutorContractPin(executorInput);

    expect(plan).toEqual(planInput);
    expect(executor).toEqual(executorInput);
    expectRecursivelyFrozen(plan);
    expectRecursivelyFrozen(executor);
    expectTypeOf(plan).toEqualTypeOf<ExecutionPlanPin>();
    expectTypeOf(executor).toEqualTypeOf<ExecutorContractPin>();

    planInput.id = 'changed';
    executorInput.adapterId = 'changed';
    expect(plan.id).toBe('release-plan');
    expect(executor.adapterId).toBe('agent-adapter');
  });

  test('rejects empty, oversized, control-bearing, surrogate, accessor, and extra pin fields', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'id', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'secret';
      },
    });

    for (const input of [
      { id: '', revision: '1', digest: 'd' },
      { id: 'x'.repeat(257), revision: '1', digest: 'd' },
      { id: 'line\nbreak', revision: '1', digest: 'd' },
      { id: '\ud800', revision: '1', digest: 'd' },
      { id: 'plan', revision: '1', digest: 'd', extra: true },
      accessor,
    ]) {
      expect(() => snapshotExecutionPlanPin(input)).toThrow(/./);
    }
    expect(getterCalls).toBe(0);
  });

  test('digests the complete immutable configuration with canonical JSON', () => {
    const input = { nested: { z: 2, a: 1 }, values: [true, null] };
    const snapshot = snapshotExecutorConfiguration(input);
    const equivalent = snapshotExecutorConfiguration({
      values: [true, null],
      nested: { a: 1, z: 2 },
    });

    expect(snapshot.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(equivalent.digest).toBe(snapshot.digest);
    expect(snapshot.configuration).toEqual(input);
    expectRecursivelyFrozen(snapshot);

    input.nested.a = 9;
    expect(snapshot.configuration).toEqual({
      nested: { z: 2, a: 1 },
      values: [true, null],
    });
  });
});

describe('bounded policies', () => {
  test('accepts and freezes complete retry, timeout, lease, and concurrency policies', () => {
    const retry = snapshotRetryPolicy(retryPolicy);
    const timeout = snapshotTimeoutPolicy(timeoutPolicy);
    const lease = snapshotLeasePolicy({
      heartbeatIntervalMs: 1_000,
      leaseDurationMs: 5_000,
    });
    const concurrency = snapshotProcessLocalConcurrencyPolicy({
      maximumConcurrentExecutions: 8,
      maximumConcurrentExecutionsPerExecutor: 4,
    });

    expectTypeOf(retry).toEqualTypeOf<RetryPolicy>();
    expectTypeOf(timeout).toEqualTypeOf<TimeoutPolicy>();
    expectTypeOf(lease).toEqualTypeOf<LeasePolicy>();
    expectTypeOf(concurrency).toEqualTypeOf<ProcessLocalConcurrencyPolicy>();
    expectRecursivelyFrozen(retry);
    expectRecursivelyFrozen(timeout);
    expectRecursivelyFrozen(lease);
    expectRecursivelyFrozen(concurrency);
  });

  test.each([
    [{ ...retryPolicy, maximumAttempts: 0 }, snapshotRetryPolicy],
    [{ ...retryPolicy, maximumAttempts: 101 }, snapshotRetryPolicy],
    [{ ...retryPolicy, maximumBackoffMs: 99 }, snapshotRetryPolicy],
    [{ ...retryPolicy, backoffMultiplier: 17 }, snapshotRetryPolicy],
    [{ ...timeoutPolicy, executionTimeoutMs: 0 }, snapshotTimeoutPolicy],
    [{ ...timeoutPolicy, cancellationTimeoutMs: 86_400_001 }, snapshotTimeoutPolicy],
    [{ heartbeatIntervalMs: 1_000, leaseDurationMs: 1_000 }, snapshotLeasePolicy],
    [{ heartbeatIntervalMs: 99, leaseDurationMs: 5_000 }, snapshotLeasePolicy],
    [
      {
        maximumConcurrentExecutions: 4,
        maximumConcurrentExecutionsPerExecutor: 5,
      },
      snapshotProcessLocalConcurrencyPolicy,
    ],
    [
      {
        maximumConcurrentExecutions: 1_025,
        maximumConcurrentExecutionsPerExecutor: 1,
      },
      snapshotProcessLocalConcurrencyPolicy,
    ],
  ])('rejects an invalid policy %#', (input, snapshot) => {
    expect(() => snapshot(input)).toThrow(RangeError);
  });
});

describe('execution plan document', () => {
  const emptyConfigurationDigest = snapshotExecutorConfiguration({}).digest;

  const bindingFor = (nodeKey: string): object => ({
    configuration: {},
    configurationDigest: emptyConfigurationDigest,
    executor: {
      adapterId: 'adapter',
      digest: 'contract:opaque',
      revision: '1',
    },
    nodeKey,
    retryPolicy,
    timeoutPolicy,
  });

  test('creates a JSON-only immutable document with exact executor bindings', () => {
    const configuration = {
      model: 'host-value',
      nested: { enabled: true },
      values: [1, 'two'],
    };
    const configurationDigest = snapshotExecutorConfiguration(configuration).digest;
    const input = {
      compiledPipeline: { entry: 'node-a', nodes: [{ key: 'node-a' }] },
      executorBindings: [
        {
          configuration,
          configurationDigest,
          executor: {
            adapterId: 'adapter',
            digest: 'contract:opaque',
            revision: '1',
          },
          idempotentExecution: true,
          nodeKey: 'node-a',
          retryPolicy,
          timeoutPolicy,
        },
      ],
      pin: {
        digest: 'host-plan:opaque',
        id: 'plan',
        revision: '1',
      },
    };

    const document = snapshotRunExecutionPlanDocument(input);

    expectTypeOf(document).toEqualTypeOf<RunExecutionPlanDocument>();
    expect(document).toEqual(input);
    expectRecursivelyFrozen(document);

    configuration.nested.enabled = false;
    input.compiledPipeline.entry = 'changed';
    expect(document.compiledPipeline).toEqual({
      entry: 'node-a',
      nodes: [{ key: 'node-a' }],
    });
    expect(document.executorBindings[0]?.configuration).toEqual({
      model: 'host-value',
      nested: { enabled: true },
      values: [1, 'two'],
    });
  });

  test('defaults a missing idempotency declaration to false', () => {
    const configuration = { command: 'safe-only-when-declared' };
    const document = snapshotRunExecutionPlanDocument({
      compiledPipeline: {},
      executorBindings: [
        {
          configuration,
          configurationDigest: snapshotExecutorConfiguration(configuration).digest,
          executor: { adapterId: 'adapter', digest: 'digest', revision: '1' },
          nodeKey: 'node',
          retryPolicy,
          timeoutPolicy,
        },
      ],
      pin: { digest: 'opaque', id: 'plan', revision: '1' },
    });

    expect(document.executorBindings[0]?.idempotentExecution).toBe(false);
  });

  test('accounts normalized defaults at the exact shared member boundary', () => {
    const exactCompiledPipeline = Array.from({ length: 65_512 }, () => null);
    const exact = snapshotRunExecutionPlanDocument({
      compiledPipeline: exactCompiledPipeline,
      executorBindings: [bindingFor('node')],
      pin: { digest: 'opaque', id: 'plan', revision: '1' },
    });

    expect(exact.executorBindings[0]?.idempotentExecution).toBe(false);
    expect(() =>
      snapshotRunExecutionPlanDocument({
        compiledPipeline: [...exactCompiledPipeline, null],
        executorBindings: [bindingFor('node')],
        pin: { digest: 'opaque', id: 'plan', revision: '1' },
      }),
    ).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum member count of 65536.'),
    );
  });

  test('accounts normalized defaults at the exact shared UTF-8 boundary for large bindings', () => {
    const executorBindings = Array.from({ length: 128 }, (_, index) => bindingFor(`node-${index}`));
    const input = {
      compiledPipeline: { padding: '' },
      executorBindings,
      pin: { digest: 'opaque-plan-digest', id: 'plan', revision: '1' },
    };
    const normalizedForSizing = {
      ...input,
      executorBindings: executorBindings.map((binding) => ({
        ...binding,
        idempotentExecution: false,
      })),
    };
    const remainingBytes =
      1_048_576 - Buffer.byteLength(JSON.stringify(normalizedForSizing), 'utf8');
    expect(remainingBytes).toBeGreaterThan(0);

    const exact = snapshotRunExecutionPlanDocument({
      ...input,
      compiledPipeline: { padding: 'x'.repeat(remainingBytes) },
    });
    expect(Buffer.byteLength(canonicalizeJson(exact), 'utf8')).toBe(1_048_576);
    expect(exact.pin.digest).toBe('opaque-plan-digest');

    expect(() =>
      snapshotRunExecutionPlanDocument({
        ...input,
        compiledPipeline: { padding: 'x'.repeat(remainingBytes + 1) },
      }),
    ).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum UTF-8 size of 1048576 bytes.'),
    );
  });

  test('rejects duplicate nodes, digest mismatch, oversized binding sets, and hostile JSON', () => {
    const binding = {
      configuration: { value: 1 },
      configurationDigest: snapshotExecutorConfiguration({ value: 1 }).digest,
      executor: { adapterId: 'adapter', digest: 'digest', revision: '1' },
      nodeKey: 'node',
      retryPolicy,
      timeoutPolicy,
    };
    const document = (executorBindings: readonly unknown[]): unknown => ({
      compiledPipeline: {},
      executorBindings,
      pin: { digest: 'opaque', id: 'plan', revision: '1' },
    });

    expect(() => snapshotRunExecutionPlanDocument(document([binding, binding]))).toThrow(TypeError);
    expect(() =>
      snapshotRunExecutionPlanDocument(
        document([{ ...binding, configurationDigest: `sha256:${'0'.repeat(64)}` }]),
      ),
    ).toThrow(TypeError);
    expect(() =>
      snapshotRunExecutionPlanDocument(
        document(
          Array.from({ length: 4_097 }, (_, index) => ({ ...binding, nodeKey: `n${index}` })),
        ),
      ),
    ).toThrow(RangeError);
    expect(() =>
      snapshotRunExecutionPlanDocument({
        compiledPipeline: { value: Symbol('secret') },
        executorBindings: [],
        pin: { digest: 'opaque', id: 'plan', revision: '1' },
      }),
    ).toThrow(TypeError);
  });
});

describe('closed output payloads', () => {
  const artifact = {
    artifactId: 'artifact-1',
    bytes: 0,
    mediaType: 'application/json',
    sha256: 'a'.repeat(64),
  };

  test('copies the minimal provider-neutral artifact reference', () => {
    const snapshot = snapshotRunArtifactReference(artifact);

    expectTypeOf(snapshot).toEqualTypeOf<RunArtifactReference>();
    expect(snapshot).toEqual(artifact);
    expect(Object.keys(snapshot).sort()).toEqual(['artifactId', 'bytes', 'mediaType', 'sha256']);
    expectRecursivelyFrozen(snapshot);
  });

  test.each([
    { ...artifact, artifactId: '' },
    { ...artifact, artifactId: 'x'.repeat(257) },
    { ...artifact, artifactId: 'bad\u0000id' },
    { ...artifact, artifactId: '\ud800' },
    { ...artifact, mediaType: 'application/json; charset=utf-8' },
    { ...artifact, mediaType: 'text' },
    { ...artifact, mediaType: 'téxt/plain' },
    { ...artifact, sha256: 'A'.repeat(64) },
    { ...artifact, sha256: 'a'.repeat(63) },
    { ...artifact, bytes: -1 },
    { ...artifact, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...artifact, provider: 's3' },
    { ...artifact, url: 'https://example.invalid/artifact' },
  ])('rejects invalid or provider-specific artifact input %#', (input) => {
    expect(() => snapshotRunArtifactReference(input)).toThrow(/./);
  });

  test('copies the closed JSON and artifact output variants', () => {
    const jsonInput = { kind: 'json', value: { nested: [1, true] } };
    const artifactInput = { artifact, kind: 'artifact' };
    const json = snapshotRunOutputPayload(jsonInput);
    const artifactPayload = snapshotRunOutputPayload(artifactInput);

    expectTypeOf(json).toEqualTypeOf<RunOutputPayload>();
    expectTypeOf(artifactPayload).toEqualTypeOf<RunOutputPayload>();
    expect(json).toEqual(jsonInput);
    expect(artifactPayload).toEqual(artifactInput);
    expectRecursivelyFrozen(json);
    expectRecursivelyFrozen(artifactPayload);

    jsonInput.value.nested[0] = 9;
    artifact.artifactId = 'changed';
    expect(json).toEqual({ kind: 'json', value: { nested: [1, true] } });
    expect(artifactPayload).toEqual({
      artifact: {
        artifactId: 'artifact-1',
        bytes: 0,
        mediaType: 'application/json',
        sha256: 'a'.repeat(64),
      },
      kind: 'artifact',
    });
  });

  test('uses ordinary frozen readonly arrays in every portable JSON surface', () => {
    expect.assertions(15);
    const configuration = snapshotExecutorConfiguration([1, 2]).configuration;
    const document = snapshotRunExecutionPlanDocument({
      compiledPipeline: [1, 2],
      executorBindings: [],
      pin: { digest: 'opaque', id: 'plan', revision: '1' },
    });
    const output = snapshotRunOutputPayload({ kind: 'json', value: [1, 2] });

    expectPortableArrayBehavior(configuration);
    expectPortableArrayBehavior(document.compiledPipeline);
    if (output.kind !== 'json') throw new TypeError('Expected a JSON output payload.');
    expectPortableArrayBehavior(output.value);
  });

  test('exposes bounded typed fault contracts without runtime error values', () => {
    const fault: RunFault = {
      code: 'PLAN_MISMATCH',
      message: 'The loaded plan does not match the persisted exact pin.',
    };
    const conflict: RunConflict = {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'The idempotency key is already bound to another request.',
    };
    expectTypeOf(fault).toEqualTypeOf<RunFault>();
    expectTypeOf(conflict).toEqualTypeOf<RunConflict>();
    expectTypeOf<RunFault['code']>().not.toEqualTypeOf<string>();
    expectTypeOf<RunConflict['code']>().not.toEqualTypeOf<string>();
    expectTypeOf<RunExecutionPlanDocument['compiledPipeline']>().not.toBeFunction();
    expectTypeOf<RunExecutionPlanExecutorBinding>().toHaveProperty('idempotentExecution');
    expectTypeOf<keyof RunArtifactReference>().toEqualTypeOf<
      'artifactId' | 'bytes' | 'mediaType' | 'sha256'
    >();
    expect(snapshotRunFaultMessage(fault.message)).toBe(fault.message);
    expect(snapshotRunFaultMessage(conflict.message)).toBe(conflict.message);
    expect(() => snapshotRunFaultMessage('x'.repeat(513))).toThrow(RangeError);
    expect(() => snapshotRunFaultMessage('bad\u0000message')).toThrow(TypeError);
  });
});
