import { describe, expect, expectTypeOf, test } from 'vitest';

import type {
  ExecutorFailureFault,
  ExecutorFailureFaultCode,
  ExecutorUnknownOutcomeFault,
} from '../../src/errors/index.js';
import {
  snapshotExecutorAttemptReference,
  snapshotExecutorInvocationSnapshot,
  snapshotExecutorOutput,
  snapshotExecutorOutputs,
  snapshotExecutorConfiguration,
  verifyExecutorBinding,
} from '../../src/policy/index.js';
import type {
  ExecutorCancelRequest,
  ExecutorCancelResult,
  ExecutorExecuteRequest,
  ExecutorReconcileRequest,
  ExecutorReconcileResult,
  ResolvedExecutor,
} from '../../src/ports/index.js';
import type {
  ExecutorAttemptReference,
  ExecutorInvocationSnapshot,
  ExecutorOutput,
} from '../../src/spec/index.js';

const pin = { adapterId: 'adapter', digest: 'contract', revision: '1' };
const configuration = { model: 'stable' };
const configurationDigest = snapshotExecutorConfiguration(configuration).digest;
const attempt = {
  activationId: 'activation',
  attemptId: 'attempt',
  dispatchIdempotencyKey: 'dispatch',
  nodeInstanceId: 'node-instance',
  nodeKey: 'node',
  runId: 'run',
};

describe('executor snapshots', () => {
  test('copies and freezes exact invocation data', () => {
    const mutableConfiguration = { model: 'stable' };
    const mutableConfigurationDigest = snapshotExecutorConfiguration(mutableConfiguration).digest;
    const input = {
      activationContext: { branch: [1, 2] },
      attempt,
      executorConfiguration: mutableConfiguration,
      executorConfigurationDigest: mutableConfigurationDigest,
      executorContractPin: pin,
      runInput: { value: true },
    };
    const snapshot = snapshotExecutorInvocationSnapshot(input);

    expectTypeOf(snapshot).toEqualTypeOf<ExecutorInvocationSnapshot>();
    expect(snapshot).toEqual(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.attempt)).toBe(true);
    expect(Object.isFrozen(snapshot.executorConfiguration)).toBe(true);
    mutableConfiguration.model = 'changed';
    expect(snapshot.executorConfiguration).toEqual({ model: 'stable' });
  });

  test('enforces exact reference shape and 256-byte text bounds', () => {
    expectTypeOf(
      snapshotExecutorAttemptReference(attempt),
    ).toEqualTypeOf<ExecutorAttemptReference>();
    expect(snapshotExecutorAttemptReference({ ...attempt, runId: '😀'.repeat(64) }).runId).toBe(
      '😀'.repeat(64),
    );
    expect(() => snapshotExecutorAttemptReference({ ...attempt, runId: '😀'.repeat(65) })).toThrow(
      RangeError,
    );
    expect(() => snapshotExecutorAttemptReference({ ...attempt, extra: true })).toThrow(TypeError);
    expect(() => snapshotExecutorAttemptReference({ ...attempt, nodeKey: 'bad\nkey' })).toThrow(
      TypeError,
    );
  });

  test('rejects hostile and mismatched invocation data without invoking accessors', () => {
    let calls = 0;
    const hostile = Object.defineProperty({}, 'attempt', {
      enumerable: true,
      get: () => {
        calls += 1;
        return attempt;
      },
    });
    expect(() => snapshotExecutorInvocationSnapshot(hostile)).toThrow(TypeError);
    expect(calls).toBe(0);
    expect(() =>
      snapshotExecutorInvocationSnapshot({
        activationContext: {},
        attempt,
        executorConfiguration: {},
        executorConfigurationDigest: configurationDigest,
        executorContractPin: pin,
        runInput: {},
      }),
    ).toThrow(TypeError);
  });

  test('accepts bounded unique outputs and rejects duplicates and overflow', () => {
    const output = snapshotExecutorOutput({
      name: 'result',
      payload: { kind: 'json', value: { ok: true } },
    });
    expectTypeOf(output).toEqualTypeOf<ExecutorOutput>();
    expect(Object.isFrozen(output)).toBe(true);
    expect(snapshotExecutorOutputs([])).toEqual([]);
    expect(
      snapshotExecutorOutputs(
        Array.from({ length: 4_096 }, (_, index) => ({
          name: `output-${index}`,
          payload: { kind: 'json', value: null },
        })),
      ),
    ).toHaveLength(4_096);
    expect(() =>
      snapshotExecutorOutputs(
        Array.from({ length: 4_097 }, (_, index) => ({
          name: `output-${index}`,
          payload: { kind: 'json', value: null },
        })),
      ),
    ).toThrow(RangeError);
    expect(() =>
      snapshotExecutorOutputs([
        { name: 'same', payload: { kind: 'json', value: 1 } },
        { name: 'same', payload: { kind: 'json', value: 2 } },
      ]),
    ).toThrow(TypeError);
    expect(
      snapshotExecutorOutputs([
        { name: 'Name', payload: { kind: 'json', value: 1 } },
        { name: 'name', payload: { kind: 'json', value: 2 } },
      ]),
    ).toHaveLength(2);
  });
});

describe('executor binding verification', () => {
  const input = {
    attempt: {
      executorConfigurationDigest: configurationDigest,
      executorContractPin: pin,
    },
    binding: {
      configuration,
      configurationDigest,
      executor: pin,
      idempotentExecution: true,
    },
    resolvedExecutorContractPin: pin,
  };

  test('returns frozen defensive evidence and defaults missing idempotence to false', () => {
    const verified = verifyExecutorBinding(input);
    expect(verified).toEqual({
      evidence: {
        executorConfiguration: configuration,
        executorConfigurationDigest: configurationDigest,
        executorContractPin: pin,
        idempotentExecution: true,
      },
      kind: 'verified',
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.kind === 'verified' && verified.evidence)).toBe(true);

    const withoutFlag = {
      ...input,
      binding: {
        configuration,
        configurationDigest,
        executor: pin,
      },
    };
    expect(verifyExecutorBinding(withoutFlag)).toMatchObject({
      evidence: { idempotentExecution: false },
      kind: 'verified',
    });
    expect(() =>
      verifyExecutorBinding({
        ...input,
        binding: { ...input.binding, idempotentExecution: 'yes' },
      }),
    ).toThrow(TypeError);
  });

  test.each([
    [
      'binding_configuration_digest_mismatch',
      { binding: { ...input.binding, configurationDigest: 'sha256:' + '0'.repeat(64) } },
    ],
    [
      'attempt_adapter_id_mismatch',
      { attempt: { ...input.attempt, executorContractPin: { ...pin, adapterId: 'other' } } },
    ],
    [
      'attempt_revision_mismatch',
      { attempt: { ...input.attempt, executorContractPin: { ...pin, revision: '2' } } },
    ],
    [
      'attempt_contract_digest_mismatch',
      { attempt: { ...input.attempt, executorContractPin: { ...pin, digest: 'other' } } },
    ],
    [
      'attempt_configuration_digest_mismatch',
      { attempt: { ...input.attempt, executorConfigurationDigest: 'sha256:' + '0'.repeat(64) } },
    ],
    [
      'resolved_adapter_id_mismatch',
      { resolvedExecutorContractPin: { ...pin, adapterId: 'other' } },
    ],
    ['resolved_revision_mismatch', { resolvedExecutorContractPin: { ...pin, revision: '2' } }],
    [
      'resolved_contract_digest_mismatch',
      { resolvedExecutorContractPin: { ...pin, digest: 'other' } },
    ],
  ] as const)('returns %s first', (reason, change) => {
    expect(verifyExecutorBinding({ ...input, ...change })).toEqual({ kind: 'mismatch', reason });
  });

  test('uses deterministic mismatch precedence', () => {
    expect(
      verifyExecutorBinding({
        ...input,
        attempt: {
          executorConfigurationDigest: 'sha256:' + '0'.repeat(64),
          executorContractPin: { adapterId: 'other', digest: 'other', revision: '2' },
        },
        resolvedExecutorContractPin: { adapterId: 'other', digest: 'other', revision: '2' },
      }),
    ).toEqual({ kind: 'mismatch', reason: 'attempt_adapter_id_mismatch' });
  });
});

test('executor requests retain the caller-owned signal and capabilities stay optional', () => {
  const signal = new AbortController().signal;
  const invocation = snapshotExecutorInvocationSnapshot({
    activationContext: {},
    attempt,
    executorConfiguration: configuration,
    executorConfigurationDigest: configurationDigest,
    executorContractPin: pin,
    runInput: {},
  });
  const execute: ExecutorExecuteRequest = { invocation, operation: 'execute', signal };
  const reconcile: ExecutorReconcileRequest = { invocation, operation: 'reconcile', signal };
  const cancel: ExecutorCancelRequest = { invocation, operation: 'cancel', signal };
  expect(execute.signal).toBe(signal);
  expect(reconcile.signal).toBe(signal);
  expect(cancel.signal).toBe(signal);
  expectTypeOf<ResolvedExecutor['reconcile']>().toEqualTypeOf<
    ((request: ExecutorReconcileRequest) => Promise<ExecutorReconcileResult>) | undefined
  >();
  expectTypeOf<ResolvedExecutor['cancel']>().toEqualTypeOf<
    ((request: ExecutorCancelRequest) => Promise<ExecutorCancelResult>) | undefined
  >();
});

test('executor faults exclude cancellation, unknown outcome, and not found from known failure', () => {
  expectTypeOf<ExecutorFailureFault['code']>().toEqualTypeOf<ExecutorFailureFaultCode>();
  expectTypeOf<'CANCELLED'>().not.toMatchTypeOf<ExecutorFailureFaultCode>();
  expectTypeOf<'UNKNOWN_OUTCOME'>().not.toMatchTypeOf<ExecutorFailureFaultCode>();
  expectTypeOf<'NOT_FOUND'>().not.toMatchTypeOf<ExecutorFailureFaultCode>();
  expectTypeOf<ExecutorUnknownOutcomeFault['code']>().toEqualTypeOf<'UNKNOWN_OUTCOME'>();
});
