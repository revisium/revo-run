import { applyDomainOperation } from '../domain/index.js';
import {
  canonicalizeJson,
  snapshotExecutorConfiguration,
  snapshotExecutorContractPin,
  snapshotExecutorInvocationSnapshot,
  snapshotPortableJsonValue,
  snapshotRunExecutionPlanDocument,
  verifyExecutorBinding,
} from '../policy/index.js';
import type { ExecutorResolver } from '../ports/index.js';
import type {
  ExecutorInvocationSnapshot,
  JsonValue,
  RunExecutionPlanExecutorBinding,
} from '../spec/index.js';
import type {
  RunStore,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
  RunStoreTransaction,
} from '../storage/index.js';
import { resolveExactExecutor } from './exact-executor-resolution.js';
import type { LifecyclePreparedExecuteCapability } from './lifecycle-prepared-execute-capability.js';
import type { LifecycleStartReplayReceipt } from './lifecycle-start-replay-receipt.js';
import { lifecycleSupport } from './lifecycle-support.js';
import { lifecycleValidation } from './lifecycle-validation.js';
import type { LifecycleVerifyAndStartRequest } from './lifecycle-verify-and-start-request.js';
import type { LifecycleVerifyAndStartResult } from './lifecycle-verify-and-start-result.js';
import { executorObservationNormalization } from './normalize-executor-observation.js';

const {
  authority,
  conflict,
  expectation,
  fault,
  incumbentAuthority,
  invalid,
  loadAuthority,
  mapCursor,
  mapDomainError,
  mapNonCommit,
  notFound,
  safeAdd,
  samePin,
} = lifecycleSupport;

const unavailable = (): LifecycleVerifyAndStartResult =>
  fault('EXECUTOR_UNAVAILABLE', 'Exact executor is unavailable.');

const startIdentity = (request: LifecycleVerifyAndStartRequest): RunStoreIdempotencyIdentity => ({
  key: request.authority.dispatchIdempotencyKey,
  operation: 'start_attempt',
  runId: request.authority.runId,
  subjectId: request.authority.attemptId,
});

const startRequest = (
  request: LifecycleVerifyAndStartRequest,
  binding: RunExecutionPlanExecutorBinding,
): JsonValue =>
  snapshotPortableJsonValue({
    authority: {
      activationId: request.authority.activationId,
      attemptId: request.authority.attemptId,
      attemptPhase: 'claimed',
      dispatchIdempotencyKey: request.authority.dispatchIdempotencyKey,
      executorConfigurationDigest: request.authority.executorConfigurationDigest,
      executorContractPin: request.authority.executorContractPin,
      expectedAttemptRevision: request.authority.expectedAttemptRevision,
      expectedNodeRevision: request.authority.expectedNodeRevision,
      expectedRunRevision: request.authority.expectedRunRevision,
      fencingToken: request.authority.fencingToken,
      leaseExpiresAt: request.authority.leaseExpiresAt,
      managerIncarnationId: request.authority.managerIncarnationId,
      nodeInstanceId: request.authority.nodeInstanceId,
      nodeKey: request.authority.nodeKey,
      nodePhase: 'executing',
      planPin: request.authority.planPin,
      runId: request.authority.runId,
    },
    binding: {
      executorConfiguration: binding.configuration,
      executorConfigurationDigest: binding.configurationDigest,
      executorContractPin: binding.executor,
      idempotentExecution: binding.idempotentExecution,
      nodeKey: binding.nodeKey,
    },
    version: 1,
  });

const expectedReceipt = (request: LifecycleVerifyAndStartRequest): LifecycleStartReplayReceipt =>
  Object.freeze({
    attemptId: request.authority.attemptId,
    attemptPhase: 'start_committed',
    attemptRevision: safeAdd(request.authority.expectedAttemptRevision, 1),
    fencingToken: request.authority.fencingToken,
    managerIncarnationId: request.authority.managerIncarnationId,
    nodeInstanceId: request.authority.nodeInstanceId,
    nodePhase: 'executing',
    runId: request.authority.runId,
  });

const parseStartSemanticRequest = (value: JsonValue | undefined): JsonValue => {
  const request = exactRecord(value, ['authority', 'binding', 'version']);
  if (request['version'] !== 1) throw new TypeError('Start replay request is invalid.');
  const parsedAuthority = lifecycleValidation.authority(request['authority']);
  if (parsedAuthority.attemptPhase !== 'claimed' || parsedAuthority.nodePhase !== 'executing') {
    throw new TypeError('Start replay request is invalid.');
  }
  const binding = exactRecord(request['binding'], [
    'executorConfiguration',
    'executorConfigurationDigest',
    'executorContractPin',
    'idempotentExecution',
    'nodeKey',
  ]);
  const configuration = snapshotExecutorConfiguration(binding['executorConfiguration']);
  const configurationDigest = text(binding['executorConfigurationDigest']);
  const contractPin = snapshotExecutorContractPin(binding['executorContractPin']);
  const nodeKey = text(binding['nodeKey']);
  if (typeof binding['idempotentExecution'] !== 'boolean') {
    throw new TypeError('Start replay request is invalid.');
  }
  if (
    configurationDigest !== configuration.digest ||
    configurationDigest !== parsedAuthority.executorConfigurationDigest ||
    nodeKey !== parsedAuthority.nodeKey ||
    !samePin(contractPin, parsedAuthority.executorContractPin)
  ) {
    throw new TypeError('Start replay request is invalid.');
  }
  return snapshotPortableJsonValue({
    authority: parsedAuthority,
    binding: {
      executorConfiguration: configuration.configuration,
      executorConfigurationDigest: configuration.digest,
      executorContractPin: contractPin,
      idempotentExecution: binding['idempotentExecution'],
      nodeKey,
    },
    version: 1,
  });
};

const replay = (
  record: RunStoreIdempotencyRecord,
  identity: RunStoreIdempotencyIdentity,
  semanticRequest: JsonValue,
  expected: LifecycleStartReplayReceipt,
): LifecycleVerifyAndStartResult => {
  const snapshot = snapshotPortableJsonValue(record);
  const top = exactRecord(snapshot, ['committedAt', 'cursor', 'identity', 'request', 'result']);
  const storedIdentity = exactRecord(top['identity'], ['key', 'operation', 'runId', 'subjectId']);
  const cursor = exactRecord(top['cursor'], ['runId', 'sequence']);
  const value = exactRecord(top['result'], [
    'attemptId',
    'attemptPhase',
    'attemptRevision',
    'fencingToken',
    'managerIncarnationId',
    'nodeInstanceId',
    'nodePhase',
    'runId',
  ]);
  const committedAt = nonnegativeInteger(top['committedAt']);
  const cursorSequence = nonnegativeInteger(cursor['sequence']);
  const storedRequest = parseStartSemanticRequest(top['request']);
  if (
    boundedText(storedIdentity['key']) !== identity.key ||
    boundedText(storedIdentity['operation']) !== identity.operation ||
    boundedText(storedIdentity['runId']) !== identity.runId ||
    boundedText(storedIdentity['subjectId']) !== identity.subjectId ||
    boundedText(cursor['runId']) !== identity.runId
  ) {
    throw new TypeError('Start replay record is invalid.');
  }
  const attemptPhase = boundedText(value['attemptPhase']);
  const nodePhase = boundedText(value['nodePhase']);
  if (attemptPhase !== 'start_committed' || nodePhase !== 'executing') {
    throw new TypeError('Start replay receipt is invalid.');
  }
  const receipt: LifecycleStartReplayReceipt = Object.freeze({
    attemptId: boundedText(value['attemptId']),
    attemptPhase,
    attemptRevision: nonnegativeInteger(value['attemptRevision']),
    fencingToken: nonnegativeInteger(value['fencingToken']),
    managerIncarnationId: boundedText(value['managerIncarnationId']),
    nodeInstanceId: boundedText(value['nodeInstanceId']),
    nodePhase,
    runId: boundedText(value['runId']),
  });
  if (canonicalizeJson(storedRequest) !== canonicalizeJson(semanticRequest)) {
    return conflict({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Start identity was reused with different semantics.',
    });
  }
  if (canonicalizeJson({ ...receipt }) !== canonicalizeJson({ ...expected })) {
    throw new TypeError('Start replay receipt is invalid.');
  }
  return Object.freeze({
    committedAt,
    cursor: mapCursor({ runId: identity.runId, sequence: cursorSequence }),
    kind: 'replayed',
    value: receipt,
  });
};

const exactRecord = (
  value: JsonValue | undefined,
  keys: readonly string[],
): Readonly<Record<string, JsonValue>> => {
  if (!isJsonRecord(value)) {
    throw new TypeError('Start replay record is invalid.');
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError('Start replay record is invalid.');
  }
  return value;
};

const isJsonRecord = (value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

const text = (value: JsonValue | undefined): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Start replay record is invalid.');
  }
  return value;
};

const boundedText = (value: JsonValue | undefined): string =>
  lifecycleValidation.boundedText(value);

const nonnegativeInteger = (value: JsonValue | undefined): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Start replay record is invalid.');
  }
  return value;
};

const replaySafely = (
  record: RunStoreIdempotencyRecord,
  identity: RunStoreIdempotencyIdentity,
  semanticRequest: JsonValue,
  expected: LifecycleStartReplayReceipt,
): LifecycleVerifyAndStartResult => {
  try {
    return replay(record, identity, semanticRequest, expected);
  } catch {
    return invalid();
  }
};

const lookupReplay = async (
  transaction: RunStoreTransaction,
  identity: RunStoreIdempotencyIdentity,
  semanticRequest: JsonValue,
  expected: LifecycleStartReplayReceipt,
): Promise<LifecycleVerifyAndStartResult | null> => {
  const found = await transaction.getIdempotency(identity);
  if (found.kind === 'invalid_input') return invalid();
  return found.kind === 'found'
    ? replaySafely(found.value, identity, semanticRequest, expected)
    : null;
};

const correlationIsStale = (
  request: LifecycleVerifyAndStartRequest,
  loaded: Extract<Awaited<ReturnType<typeof loadAuthority>>, { readonly kind: 'found' }>,
): boolean =>
  loaded.attempt.runId !== loaded.run.id ||
  loaded.attempt.nodeInstanceId !== loaded.node.id ||
  loaded.node.runId !== loaded.run.id ||
  loaded.node.id !== request.authority.nodeInstanceId ||
  loaded.node.activationId !== request.authority.activationId ||
  loaded.node.nodeKey !== request.authority.nodeKey ||
  loaded.attempt.id !== request.authority.attemptId ||
  loaded.attempt.dispatchIdempotencyKey !== request.authority.dispatchIdempotencyKey ||
  loaded.node.activeAttemptId !== loaded.attempt.id;

const revisionsAreStale = (
  request: LifecycleVerifyAndStartRequest,
  loaded: Extract<Awaited<ReturnType<typeof loadAuthority>>, { readonly kind: 'found' }>,
): boolean =>
  loaded.run.revision !== request.authority.expectedRunRevision ||
  loaded.node.revision !== request.authority.expectedNodeRevision ||
  loaded.attempt.revision !== request.authority.expectedAttemptRevision;

const checkAuthority = async (
  transaction: RunStoreTransaction,
  request: LifecycleVerifyAndStartRequest,
) => {
  const loaded = await loadAuthority(transaction, request.authority);
  if (loaded.kind === 'invalid_input') return { result: invalid() } as const;
  if (loaded.kind === 'not_found') return { result: notFound() } as const;
  const { attempt, node, run } = loaded;
  if (correlationIsStale(request, loaded)) {
    return {
      result: conflict({ code: 'STALE_FENCE', message: 'Start authority is stale.' }),
    } as const;
  }
  if (!samePin(run.planPin, request.authority.planPin)) {
    return { result: fault('PLAN_MISMATCH', 'Authoritative Run plan pin differs.') } as const;
  }
  const handoff = await transaction.getHandoff({
    attemptId: attempt.id,
    incumbentFencingToken: attempt.fencingToken,
  });
  if (handoff.kind === 'invalid_input') return { result: invalid() } as const;
  if (
    attempt.managerIncarnationId !== request.authority.managerIncarnationId ||
    attempt.fencingToken !== request.authority.fencingToken ||
    handoff.kind === 'found'
  ) {
    return {
      result: conflict({ code: 'STALE_FENCE', message: 'Start authority is stale.' }),
    } as const;
  }
  if (revisionsAreStale(request, loaded)) {
    return {
      result: conflict({
        code: 'REVISION_CONFLICT',
        message: 'Start authority revision is stale.',
      }),
    } as const;
  }
  if (run.status !== 'running' || node.status !== 'executing' || attempt.status !== 'claimed') {
    return {
      result: conflict({ code: 'INVALID_STATE', message: 'Start state is incompatible.' }),
    } as const;
  }
  if (
    !samePin(attempt.executorContractPin, request.authority.executorContractPin) ||
    attempt.executorConfigurationDigest !== request.authority.executorConfigurationDigest
  ) {
    return {
      result: conflict({
        code: 'INVALID_STATE',
        message: 'Start executor binding is incompatible.',
      }),
    } as const;
  }
  if (
    attempt.leaseExpiresAt !== request.authority.leaseExpiresAt ||
    transaction.transactionNow >= attempt.leaseExpiresAt
  ) {
    return { result: conflict({ code: 'STALE_FENCE', message: 'Start lease is stale.' }) } as const;
  }
  return { attempt, node, run } as const;
};

const createCapability = (
  resolution: Awaited<ReturnType<typeof resolveExactExecutor>>,
  invocation: ExecutorInvocationSnapshot,
): LifecyclePreparedExecuteCapability => {
  let consumed = false;
  const invoke = Object.freeze(async (signal: AbortSignal) => {
    if (consumed) throw new TypeError('Prepared execute capability was already consumed.');
    consumed = true;
    return executorObservationNormalization.invokeExecute(() => {
      const result: unknown = Reflect.apply(resolution.execute, resolution.executor, [
        Object.freeze({ invocation, operation: 'execute', signal }),
      ]);
      return Promise.resolve(result);
    });
  });
  return Object.freeze({ invoke });
};

const snapshotInvocation = (
  loaded: Exclude<
    Awaited<ReturnType<typeof checkAuthority>>,
    { readonly result: LifecycleVerifyAndStartResult }
  >,
  verified: Extract<ReturnType<typeof verifyExecutorBinding>, { readonly kind: 'verified' }>,
): ExecutorInvocationSnapshot | null => {
  try {
    return snapshotExecutorInvocationSnapshot({
      activationContext: loaded.node.activationContext,
      attempt: {
        activationId: loaded.node.activationId,
        attemptId: loaded.attempt.id,
        dispatchIdempotencyKey: loaded.attempt.dispatchIdempotencyKey,
        nodeInstanceId: loaded.node.id,
        nodeKey: loaded.node.nodeKey,
        runId: loaded.run.id,
      },
      executorConfiguration: verified.evidence.executorConfiguration,
      executorConfigurationDigest: verified.evidence.executorConfigurationDigest,
      executorContractPin: verified.evidence.executorContractPin,
      runInput: loaded.run.input,
    });
  } catch {
    return null;
  }
};

const commitStart = (
  store: RunStore,
  request: LifecycleVerifyAndStartRequest,
  identity: RunStoreIdempotencyIdentity,
  semanticRequest: JsonValue,
  expected: LifecycleStartReplayReceipt,
  resolution: Awaited<ReturnType<typeof resolveExactExecutor>>,
  verified: Extract<ReturnType<typeof verifyExecutorBinding>, { readonly kind: 'verified' }>,
): Promise<LifecycleVerifyAndStartResult> =>
  store.transaction(async (transaction) => {
    const finalReplay = await transaction.getIdempotency(identity);
    if (finalReplay.kind === 'invalid_input') return invalid();
    if (finalReplay.kind === 'found') {
      return replaySafely(finalReplay.value, identity, semanticRequest, expected);
    }
    const loaded = await checkAuthority(transaction, request);
    if ('result' in loaded) return loaded.result;
    const invocation = snapshotInvocation(loaded, verified);
    if (invocation === null) return invalid();
    const capability = createCapability(resolution, invocation);
    let transition;
    try {
      transition = applyDomainOperation({
        attempt: loaded.attempt,
        authority: {
          ...incumbentAuthority(request.authority),
          transactionNow: transaction.transactionNow,
        },
        kind: 'start',
        node: loaded.node,
        run: loaded.run,
      });
    } catch (error) {
      return mapDomainError(error);
    }
    const nextAttempt = transition.attempts[0];
    const nextNode = transition.nodes[0];
    if (nextAttempt === undefined || nextNode === undefined) return invalid();
    const started = authority(transition.run, nextNode, nextAttempt);
    if (started.attemptPhase !== 'start_committed' || started.nodePhase !== 'executing') {
      return invalid();
    }
    const prepared = Object.freeze({
      authority: Object.freeze({
        ...started,
        attemptPhase: 'start_committed' as const,
        nodePhase: 'executing' as const,
      }),
      execute: capability,
      invocation,
      kind: 'execute' as const,
    });
    const result = await transaction.commit({
      authority: incumbentAuthority(request.authority),
      expected: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [expectation(loaded.run, loaded.node, loaded.attempt).attempt],
        nodes: [expectation(loaded.run, loaded.node, loaded.attempt).node],
        run: expectation(loaded.run, loaded.node, loaded.attempt).run,
      },
      idempotency: { identity, request: semanticRequest, result: { ...expected } },
      kind: 'apply_incumbent_transition',
      operation: 'start',
      transition,
    });
    if (result.kind === 'replayed') {
      return replaySafely(result.record, identity, semanticRequest, expected);
    }
    if (result.kind !== 'committed') return mapNonCommit(result);
    return Object.freeze({
      cursor: mapCursor(result.cursor),
      kind: 'committed',
      transactionNow: result.transactionNow,
      value: prepared,
    });
  });

export const verifyAndStart = async (
  store: RunStore,
  executors: ExecutorResolver,
  input: LifecycleVerifyAndStartRequest,
): Promise<LifecycleVerifyAndStartResult> => {
  let request: LifecycleVerifyAndStartRequest;
  let plan;
  try {
    request = lifecycleValidation.verifyAndStartRequest(input);
    plan = snapshotRunExecutionPlanDocument(request.planDocument);
  } catch {
    return invalid();
  }
  if (!samePin(plan.pin, request.authority.planPin)) {
    return fault('PLAN_MISMATCH', 'Execution plan pin does not match Start authority.');
  }
  const bindings = plan.executorBindings.filter(
    ({ nodeKey }) => nodeKey === request.authority.nodeKey,
  );
  if (bindings.length !== 1 || bindings[0] === undefined) {
    return fault('PLAN_MISMATCH', 'Execution plan has no exact Start binding.');
  }
  const binding = bindings[0];
  let identity;
  let semanticRequest;
  let expected;
  try {
    identity = startIdentity(request);
    semanticRequest = startRequest(request, binding);
    expected = expectedReceipt(request);
  } catch {
    return invalid();
  }
  const initial = await store.transaction(async (transaction) => {
    const foundReplay = await lookupReplay(transaction, identity, semanticRequest, expected);
    return foundReplay === null ? checkAuthority(transaction, request) : { result: foundReplay };
  });
  if ('result' in initial) return initial.result;
  let resolution;
  let verified;
  try {
    resolution = await resolveExactExecutor(executors, initial.attempt.executorContractPin);
    verified = verifyExecutorBinding({
      attempt: {
        executorConfigurationDigest: initial.attempt.executorConfigurationDigest,
        executorContractPin: initial.attempt.executorContractPin,
      },
      binding: {
        configuration: binding.configuration,
        configurationDigest: binding.configurationDigest,
        executor: binding.executor,
        idempotentExecution: binding.idempotentExecution,
      },
      resolvedExecutorContractPin: resolution.contractPin,
    });
  } catch {
    return unavailable();
  }
  if (verified.kind === 'mismatch') {
    return fault('EXECUTOR_MISMATCH', 'Exact executor binding does not match the Attempt.');
  }
  return commitStart(store, request, identity, semanticRequest, expected, resolution, verified);
};
