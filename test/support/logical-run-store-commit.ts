import { isDeepStrictEqual } from 'node:util';

import type { Attempt, DomainTransition, Run, RunNodeInstance } from '../../src/domain/index.js';
import { snapshotPortableJsonValue } from '../../src/policy/index.js';
import type {
  AttemptHandoff,
  AttemptHandoffConsumption,
  RunEventCursor,
  RunStoreAcquireAttemptCommand,
  RunStoreAttemptExpectation,
  RunStoreCommitCommand,
  RunStoreCommitResult,
  RunStoreEvent,
  RunStoreEventIntent,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
  RunStoreIdempotencyWrite,
  RunStoreIncumbentAuthority,
  RunStoreNewNodeExpectation,
  RunStoreRunExpectation,
  RunStoreTakeoverResult,
  RunStoreTransitionExpectations,
} from '../../src/storage/index.js';
import {
  activationIdKey,
  handoffKey,
  type LogicalRunStoreState,
  scopedActivationKey,
  snapshotValue,
} from './logical-run-store-state.js';

export type LogicalFailureStage =
  | 'run'
  | 'nodes'
  | 'attempts'
  | 'outputs'
  | 'handoff'
  | 'handoff_consumption'
  | 'events'
  | 'idempotency';

type FailureHook = (stage: LogicalFailureStage) => void;

const invalid = (message: string): RunStoreCommitResult => ({
  fault: { code: 'INVALID_INPUT', message },
  kind: 'invalid_input',
});

const conflict = (
  code: 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT' | 'STALE_ACTIVATION' | 'STALE_FENCE',
  message: string,
): RunStoreCommitResult => ({ conflict: { code, message }, kind: 'conflict' });

const identityKey = (identity: RunStoreIdempotencyIdentity): string =>
  JSON.stringify([identity.operation, identity.runId, identity.subjectId, identity.key]);

const isJsonObject = (
  value: RunStoreIdempotencyRecord['request'],
): value is { readonly [key: string]: RunStoreIdempotencyRecord['request'] } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isJsonArray = (
  value: RunStoreIdempotencyRecord['request'],
): value is readonly RunStoreIdempotencyRecord['request'][] => Array.isArray(value);

const semanticJsonEquals = (
  left: RunStoreIdempotencyRecord['request'],
  right: RunStoreIdempotencyRecord['request'],
): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (isJsonArray(left) || isJsonArray(right)) {
    return (
      isJsonArray(left) &&
      isJsonArray(right) &&
      left.length === right.length &&
      left.every((value, index) => semanticJsonEquals(value, right[index] ?? null))
    );
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every(
      (name, index) =>
        name === rightNames[index] && semanticJsonEquals(left[name] ?? null, right[name] ?? null),
    )
  );
};

const validLeasePolicy = (
  transactionNow: number,
  policy: { readonly leaseDurationMs: number; readonly heartbeatIntervalMs: number },
): boolean =>
  Number.isSafeInteger(policy.leaseDurationMs) &&
  policy.leaseDurationMs >= 1_000 &&
  policy.leaseDurationMs <= 86_400_000 &&
  Number.isSafeInteger(policy.heartbeatIntervalMs) &&
  policy.heartbeatIntervalMs >= 100 &&
  policy.heartbeatIntervalMs < policy.leaseDurationMs &&
  Number.isSafeInteger(transactionNow + policy.leaseDurationMs);

const validAttemptHandoffExpectation = (
  expected: RunStoreTransitionExpectations['attempts'][number],
): boolean =>
  expected.handoff.key.attemptId === expected.attemptId &&
  expected.handoff.key.incumbentFencingToken === expected.fencingToken;

const validTransitionHandoffKeys = (expected: RunStoreTransitionExpectations): boolean =>
  expected.attempts.every(validAttemptHandoffExpectation);

const hasUniqueValues = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

const sameIdentitySet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  hasUniqueValues(left) &&
  hasUniqueValues(right) &&
  left.every((value) => right.includes(value));

const structurallyValidTransition = (
  transition: DomainTransition,
  expected: RunStoreTransitionExpectations,
): boolean => {
  const nodeIds = transition.nodes.map((node) => node.id);
  const expectedNodeIds = expected.nodes.map((node) => node.nodeInstanceId);
  const absentNodeIds = expected.absentNodes.map((node) => node.nodeInstanceId);
  const attemptIds = transition.attempts.map((attempt) => attempt.id);
  const expectedAttemptIds = expected.attempts.map((attempt) => attempt.attemptId);
  const outputIds = transition.outputs.map((output) => output.id);
  if (
    !transition.changed ||
    transition.run.id !== expected.run.runId ||
    !sameIdentitySet(nodeIds, [...expectedNodeIds, ...absentNodeIds]) ||
    !sameIdentitySet(attemptIds, [...expectedAttemptIds, ...expected.absentAttemptIds]) ||
    !sameIdentitySet(outputIds, expected.absentOutputIds) ||
    !hasUniqueValues(
      expected.absentNodes.map((node) => JSON.stringify([node.runId, node.activationId])),
    ) ||
    !hasUniqueValues(
      expected.absentNodes.map((node) =>
        JSON.stringify([node.runId, node.forkScopeKey, node.activationKey]),
      ),
    )
  ) {
    return false;
  }
  for (const node of transition.nodes) {
    const absent = expected.absentNodes.find((candidate) => candidate.nodeInstanceId === node.id);
    if (
      absent !== undefined &&
      (absent.runId !== node.runId ||
        absent.activationId !== node.activationId ||
        absent.forkScopeKey !== node.forkScopeKey ||
        absent.activationKey !== node.activationKey)
    ) {
      return false;
    }
  }
  return transition.eventIntents.every((intent) =>
    structurallyValidEventIntent(intent, transition),
  );
};

const structurallyValidEventIntent = (
  intent: RunStoreEventIntent,
  transition: Pick<DomainTransition, 'run' | 'nodes' | 'attempts'>,
): boolean => {
  if (intent.runId !== transition.run.id) return false;
  if (intent.correlation.kind === 'run') return true;
  if (!('nodeInstanceId' in intent.correlation)) return false;
  const correlation = intent.correlation;
  const node = transition.nodes.find((candidate) => candidate.id === correlation.nodeInstanceId);
  if (node === undefined || node.activationId !== correlation.activationId) {
    return false;
  }
  if (correlation.kind === 'node') return true;
  if (!('attemptId' in correlation)) return false;
  const attempt = transition.attempts.find((candidate) => candidate.id === correlation.attemptId);
  return (
    attempt !== undefined &&
    attempt.nodeInstanceId === node.id &&
    attempt.runId === transition.run.id
  );
};

const structurallyValidCreate = (
  command: Extract<RunStoreCommitCommand, { readonly kind: 'create_run' }>,
): boolean => {
  const nodeIds = command.nodes.map((node) => node.id);
  const outputIds = command.outputs.map((output) => output.id);
  if (
    !sameIdentitySet(
      nodeIds,
      command.expected.absentNodes.map((node) => node.nodeInstanceId),
    ) ||
    !sameIdentitySet(outputIds, command.expected.absentOutputIds) ||
    command.nodes.some((node) => node.runId !== command.run.id) ||
    command.outputs.some((output) => output.runId !== command.run.id) ||
    !hasUniqueValues(
      command.nodes.map((node) => JSON.stringify([node.runId, node.activationId])),
    ) ||
    !hasUniqueValues(
      command.nodes.map((node) =>
        JSON.stringify([node.runId, node.forkScopeKey, node.activationKey]),
      ),
    )
  ) {
    return false;
  }
  for (const node of command.nodes) {
    const absent = command.expected.absentNodes.find(
      (candidate) => candidate.nodeInstanceId === node.id,
    );
    if (
      absent === undefined ||
      absent.runId !== node.runId ||
      absent.activationId !== node.activationId ||
      absent.forkScopeKey !== node.forkScopeKey ||
      absent.activationKey !== node.activationKey
    ) {
      return false;
    }
  }
  return command.eventIntents.every((intent) => {
    if (intent.runId !== command.run.id) return false;
    if (intent.correlation.kind === 'run') return true;
    if (!('nodeInstanceId' in intent.correlation)) return false;
    const correlation = intent.correlation;
    const node = command.nodes.find((candidate) => candidate.id === correlation.nodeInstanceId);
    return (
      node !== undefined &&
      node.activationId === correlation.activationId &&
      correlation.kind === 'node'
    );
  });
};

const claimExpectations = (
  command: Extract<RunStoreCommitCommand, { readonly kind: 'claim_attempt' }>,
): RunStoreTransitionExpectations => ({
  absentAttemptIds: [command.expected.absentAttemptId],
  absentNodes: command.expected.absentNodes,
  absentOutputIds: command.expected.absentOutputIds,
  attempts: [],
  nodes: [command.expected.node],
  run: command.expected.run,
});

const commandIdentity = (
  command: RunStoreCommitCommand,
): {
  readonly expected: RunStoreIdempotencyIdentity | null;
  readonly write: RunStoreIdempotencyWrite | null;
} => {
  const suppliedWrite = command.idempotency;
  const suppliedKey = suppliedWrite?.identity.key ?? '';
  if (command.kind === 'create_run') {
    return {
      expected: {
        key: suppliedKey,
        operation: 'start_run',
        runId: null,
        subjectId: null,
      },
      write: suppliedWrite,
    };
  }
  if (command.kind === 'claim_attempt') {
    return {
      expected: {
        key: suppliedKey,
        operation: 'claim_attempt',
        runId: command.expected.run.runId,
        subjectId: command.expected.node.nodeInstanceId,
      },
      write: suppliedWrite,
    };
  }
  if (command.kind === 'write_handoff') {
    return {
      expected: {
        key: suppliedKey,
        operation: 'write_handoff',
        runId: command.expected.run.runId,
        subjectId: command.expected.attempt.attemptId,
      },
      write: suppliedWrite,
    };
  }
  if (command.kind === 'acquire_attempt') {
    return {
      expected: {
        key: suppliedKey,
        operation: 'acquire_attempt',
        runId: command.expected.run.runId,
        subjectId: command.expected.attempt.attemptId,
      },
      write: suppliedWrite,
    };
  }
  if (command.kind === 'apply_unowned_transition') {
    if (
      command.operation === 'activate_nodes' ||
      command.operation === 'join_ready' ||
      command.operation === 'join_succeeded'
    ) {
      return { expected: null, write: command.idempotency };
    }
    if (command.idempotency === null) {
      return {
        expected: {
          key: '',
          operation: command.operation === 'gate_answer' ? 'answer_gate' : 'cancel_run',
          runId: command.expected.run.runId,
          subjectId:
            command.operation === 'gate_answer'
              ? (command.transition.nodes[0]?.activationId ?? '')
              : null,
        },
        write: null,
      };
    }
    return {
      expected: {
        key: suppliedKey,
        operation: command.operation === 'gate_answer' ? 'answer_gate' : 'cancel_run',
        runId: command.expected.run.runId,
        subjectId:
          command.operation === 'gate_answer'
            ? (command.transition.nodes[0]?.activationId ?? '')
            : null,
      },
      write: command.idempotency,
    };
  }
  if (command.operation === 'renew_lease') return { expected: null, write: command.idempotency };
  return {
    expected: {
      key: suppliedKey,
      operation: command.operation === 'start' ? 'start_attempt' : command.operation,
      runId: command.expected.run.runId,
      subjectId: command.authority.attemptId,
    },
    write: command.idempotency,
  };
};

const validateIncumbentCommandSemantics = (
  command: Extract<
    RunStoreCommitCommand,
    { readonly kind: 'apply_incumbent_transition'; readonly idempotency: object }
  >,
): RunStoreCommitResult | null => {
  const expectedAttempt = command.expected.attempts[0];
  const nextAttempt = command.transition.attempts[0];
  const nextNode = command.transition.nodes[0];
  const sourceStatus =
    command.operation === 'start' ||
    command.operation === 'pre_start_failure' ||
    command.operation === 'pre_start_cancellation'
      ? 'claimed'
      : command.operation.startsWith('direct_')
        ? 'start_committed'
        : command.operation.startsWith('late_') || command.operation === 'begin_reconciliation'
          ? 'unknown'
          : 'reconciling';
  const targetStatus =
    command.operation === 'start' || command.operation === 'reconciled_running'
      ? { attempt: 'start_committed', node: ['executing'] }
      : command.operation === 'begin_reconciliation'
        ? { attempt: 'reconciling', node: ['unknown'] }
        : command.operation.endsWith('_unknown')
          ? { attempt: 'unknown', node: ['unknown'] }
          : command.operation.endsWith('_success')
            ? { attempt: 'succeeded', node: ['succeeded'] }
            : command.operation.endsWith('_cancellation')
              ? { attempt: 'cancelled', node: ['cancelled'] }
              : { attempt: 'failed', node: ['failed', 'retry_waiting'] };
  const attemptOnly =
    command.operation === 'start' ||
    command.operation === 'begin_reconciliation' ||
    command.operation === 'reconciled_unknown';
  return expectedAttempt?.status === sourceStatus &&
    nextAttempt?.status === targetStatus.attempt &&
    nextNode !== undefined &&
    targetStatus.node.includes(nextNode.status) &&
    command.transition.run.revision === command.expected.run.revision + (attemptOnly ? 0 : 1) &&
    nextNode.revision === command.expected.nodes[0].revision + (attemptOnly ? 0 : 1) &&
    nextAttempt.leaseExpiresAt === expectedAttempt.leaseExpiresAt &&
    nextAttempt.fencingToken === expectedAttempt.fencingToken &&
    nextAttempt.managerIncarnationId === expectedAttempt.managerIncarnationId &&
    command.authority.fencingToken === expectedAttempt.fencingToken &&
    command.authority.managerIncarnationId === expectedAttempt.managerIncarnationId &&
    nextAttempt.executorContractPin.adapterId === command.authority.executorContractPin.adapterId &&
    nextAttempt.executorContractPin.revision === command.authority.executorContractPin.revision &&
    nextAttempt.executorContractPin.digest === command.authority.executorContractPin.digest &&
    nextAttempt.executorConfigurationDigest === command.authority.executorConfigurationDigest
    ? null
    : invalid('Incumbent operation source, result pair, revisions, or lease is invalid.');
};

const validateAcquisitionCommandSemantics = (
  command: RunStoreAcquireAttemptCommand,
): RunStoreCommitResult | null => {
  const sourceStatus = command.expected.attempt.status;
  const nextAttempt = command.change.attempt;
  const nextNode = command.change.node;
  const changesUnknownOutcome = sourceStatus === 'start_committed';
  const preservesUnknownOutcome = sourceStatus === 'unknown' || sourceStatus === 'reconciling';
  const validStatusPair =
    (sourceStatus === 'claimed' &&
      nextAttempt.status === 'claimed' &&
      nextNode.status === 'executing') ||
    ((changesUnknownOutcome || preservesUnknownOutcome) &&
      nextAttempt.status === 'unknown' &&
      nextNode.status === 'unknown');
  const revisionDelta = changesUnknownOutcome ? 1 : 0;
  const validUnknownFault =
    !changesUnknownOutcome ||
    (nextAttempt.fault?.code === 'UNKNOWN_OUTCOME' &&
      nextAttempt.fault.message.length > 0 &&
      Buffer.byteLength(nextAttempt.fault.message) <= 1_024);
  return validStatusPair &&
    command.change.run.revision === command.expected.run.revision + revisionDelta &&
    nextNode.revision === command.expected.node.revision + revisionDelta &&
    validUnknownFault
    ? null
    : invalid('Acquisition status pair, revisions, or unknown fault is invalid.');
};

const preflightCommand = (
  command: RunStoreCommitCommand,
  transactionNow: number,
): RunStoreCommitResult | null => {
  if (command.kind === 'create_run') {
    if (
      !structurallyValidCreate(command) ||
      command.run.id !== command.expected.absentRunId ||
      command.run.revision !== 0 ||
      command.run.createdAt !== transactionNow ||
      command.run.updatedAt !== transactionNow
    ) {
      return invalid('Create Run structural fields are invalid.');
    }
    return null;
  }
  if (command.kind === 'claim_attempt') {
    const attempt = command.transition.attempts[0];
    const node = command.transition.nodes[0];
    return validLeasePolicy(transactionNow, command.leasePolicy) &&
      structurallyValidTransition(command.transition, claimExpectations(command)) &&
      attempt?.id === command.expected.absentAttemptId &&
      attempt.runId === command.expected.run.runId &&
      attempt.nodeInstanceId === command.expected.node.nodeInstanceId &&
      attempt.revision === 0 &&
      attempt.createdAt === transactionNow &&
      attempt.updatedAt === transactionNow &&
      attempt.lastHeartbeatAt === transactionNow &&
      attempt.leaseExpiresAt === transactionNow + command.leasePolicy.leaseDurationMs &&
      attempt.fencingToken === 1 &&
      attempt.status === 'claimed' &&
      node?.id === command.expected.node.nodeInstanceId &&
      node.activeAttemptId === attempt.id &&
      node.status === 'executing' &&
      command.transition.eventIntents.length === 2 &&
      command.transition.eventIntents[0]?.kind === 'attempt.created' &&
      command.transition.eventIntents[1]?.kind === 'node.transitioned'
      ? null
      : invalid('Claim structure or LeasePolicy is invalid.');
  }
  if (command.kind === 'apply_incumbent_transition') {
    const next = command.transition.attempts[0];
    if (
      !structurallyValidTransition(command.transition, command.expected) ||
      !validTransitionHandoffKeys(command.expected) ||
      next?.id !== command.authority.attemptId ||
      next.runId !== command.expected.run.runId ||
      next.revision !== command.authority.expectedAttemptRevision + 1 ||
      next.updatedAt !== transactionNow ||
      command.authority.expectedRunRevision !== command.expected.run.revision ||
      command.authority.expectedNodeRevision !== command.expected.nodes[0]?.revision ||
      command.expected.attempts[0]?.attemptId !== command.authority.attemptId
    ) {
      return invalid('Incumbent transition structure is invalid.');
    }
    if (command.operation === 'renew_lease') {
      return validLeasePolicy(transactionNow, command.leasePolicy)
        ? null
        : invalid('Renewal LeasePolicy is invalid.');
    }
    if (Object.hasOwn(command, 'leasePolicy')) {
      return invalid('Non-renew incumbent operations forbid LeasePolicy.');
    }
    return validateIncumbentCommandSemantics(command);
  }
  if (
    command.kind === 'apply_unowned_transition' &&
    (!structurallyValidTransition(command.transition, command.expected) ||
      !validTransitionHandoffKeys(command.expected))
  ) {
    return invalid('Unowned transition structure is invalid.');
  }
  if (command.kind === 'write_handoff') {
    return validAttemptHandoffExpectation(command.expected.attempt) &&
      command.authority.attemptId === command.expected.attempt.attemptId &&
      command.authority.fencingToken === command.expected.attempt.fencingToken &&
      command.authority.expectedRunRevision === command.expected.run.revision &&
      command.authority.expectedNodeRevision === command.expected.node.revision &&
      command.authority.expectedAttemptRevision === command.expected.attempt.revision &&
      command.handoffId.length > 0 &&
      Buffer.byteLength(command.handoffId) <= 256
      ? null
      : invalid('Handoff expectation key is invalid.');
  }
  if (command.kind === 'acquire_attempt') {
    const handoff = command.expected.attempt.handoff;
    if (
      !validLeasePolicy(transactionNow, command.leasePolicy) ||
      !validAttemptHandoffExpectation(command.expected.attempt) ||
      handoff.key.attemptId !== command.expected.attempt.attemptId ||
      handoff.key.incumbentFencingToken !== command.expected.attempt.fencingToken ||
      (command.evidence.kind === 'lease_expired' && handoff.kind !== 'absent') ||
      (command.evidence.kind === 'handoff' &&
        (handoff.kind !== 'named' || handoff.handoffId !== command.evidence.handoffId)) ||
      command.change.attempt.id !== command.expected.attempt.attemptId ||
      command.change.node.id !== command.expected.node.nodeInstanceId ||
      command.change.run.id !== command.expected.run.runId ||
      command.change.attempt.revision !== command.expected.attempt.revision + 1 ||
      command.change.attempt.updatedAt !== transactionNow ||
      command.change.attempt.lastHeartbeatAt !== transactionNow ||
      command.change.attempt.leaseExpiresAt !==
        transactionNow + command.leasePolicy.leaseDurationMs ||
      command.change.attempt.managerIncarnationId !== command.successorManagerIncarnationId ||
      command.successorManagerIncarnationId === command.expected.attempt.managerIncarnationId ||
      command.change.attempt.fencingToken !== command.expected.attempt.fencingToken + 1
    ) {
      return invalid('Acquisition policy, evidence, or handoff key is invalid.');
    }
    return validateAcquisitionCommandSemantics(command);
  }
  return null;
};

const identitiesEqual = (
  left: RunStoreIdempotencyIdentity,
  right: RunStoreIdempotencyIdentity,
): boolean =>
  left.operation === right.operation &&
  left.runId === right.runId &&
  left.subjectId === right.subjectId &&
  left.key === right.key;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
    if (codePoint !== undefined && codePoint > 65_535) index += 1;
  }
  return false;
};

const validateIdempotency = (
  state: LogicalRunStoreState,
  command: RunStoreCommitCommand,
):
  | { readonly kind: 'continue'; readonly write: RunStoreIdempotencyWrite | null }
  | { readonly kind: 'result'; readonly result: RunStoreCommitResult } => {
  const binding = commandIdentity(command);
  if (
    (binding.expected === null) !== (binding.write === null) ||
    (binding.expected !== null &&
      binding.write !== null &&
      !identitiesEqual(binding.expected, binding.write.identity))
  ) {
    return {
      kind: 'result',
      result: invalid('Idempotency identity is missing, unexpected, or misbound.'),
    };
  }
  if (binding.write === null) return { kind: 'continue', write: null };
  const identity = binding.write.identity;
  if (
    identity.key.length === 0 ||
    Buffer.byteLength(identity.key) > 256 ||
    hasControlCharacter(identity.key) ||
    (identity.runId !== null &&
      (identity.runId.length === 0 || Buffer.byteLength(identity.runId) > 256)) ||
    (identity.subjectId !== null &&
      (identity.subjectId.length === 0 || Buffer.byteLength(identity.subjectId) > 256))
  ) {
    return { kind: 'result', result: invalid('Idempotency identity bounds are invalid.') };
  }
  let snapshottedWrite: RunStoreIdempotencyWrite;
  try {
    snapshottedWrite = {
      identity: snapshotValue(identity),
      request: snapshotPortableJsonValue(binding.write.request),
      result: snapshotPortableJsonValue(binding.write.result),
    };
  } catch {
    return { kind: 'result', result: invalid('Idempotency JSON is invalid.') };
  }
  const existing = state.idempotency.get(identityKey(identity));
  if (existing === undefined) return { kind: 'continue', write: snapshottedWrite };
  return {
    kind: 'result',
    result: semanticJsonEquals(existing.request, snapshottedWrite.request)
      ? { kind: 'replayed', record: existing }
      : conflict('IDEMPOTENCY_CONFLICT', 'Idempotency identity is bound to another request.'),
  };
};

const runExpectationMatches = (
  state: LogicalRunStoreState,
  expected: RunStoreRunExpectation,
): boolean => {
  const run = state.runs.get(expected.runId);
  return (
    run !== undefined &&
    run.revision === expected.revision &&
    run.planPin.id === expected.planPin.id &&
    run.planPin.revision === expected.planPin.revision &&
    run.planPin.digest === expected.planPin.digest
  );
};

const nodeExpectationMatches = (
  state: LogicalRunStoreState,
  expected: {
    readonly nodeInstanceId: string;
    readonly revision: number;
    readonly activeAttemptId: string | null;
  },
): boolean => {
  const node = state.nodes.get(expected.nodeInstanceId);
  return (
    node !== undefined &&
    node.revision === expected.revision &&
    node.activeAttemptId === expected.activeAttemptId
  );
};

const attemptExpectationMatches = (
  state: LogicalRunStoreState,
  expected: {
    readonly attemptId: string;
    readonly revision: number;
    readonly status: Attempt['status'];
    readonly managerIncarnationId: string;
    readonly fencingToken: number;
    readonly leaseExpiresAt: number;
  } & Pick<RunStoreAttemptExpectation, 'handoff'>,
): boolean => {
  const attempt = state.attempts.get(expected.attemptId);
  const handoffState = state.handoffs.get(handoffKey(expected.handoff.key));
  return (
    attempt !== undefined &&
    attempt.revision === expected.revision &&
    attempt.status === expected.status &&
    attempt.managerIncarnationId === expected.managerIncarnationId &&
    attempt.fencingToken === expected.fencingToken &&
    attempt.leaseExpiresAt === expected.leaseExpiresAt &&
    validAttemptHandoffExpectation(expected) &&
    (expected.handoff.kind === 'absent'
      ? handoffState === undefined
      : handoffState?.handoff.id === expected.handoff.handoffId)
  );
};

const validateNewNodes = (
  state: LogicalRunStoreState,
  nodes: readonly RunNodeInstance[],
  expected: readonly RunStoreNewNodeExpectation[],
): RunStoreCommitResult | null => {
  if (nodes.length !== expected.length)
    return invalid('New-node absence expectations are incomplete.');
  const ids = new Set<string>();
  const activations = new Set<string>();
  const scopes = new Set<string>();
  for (const node of nodes) {
    const expectation = expected.find((candidate) => candidate.nodeInstanceId === node.id);
    if (
      expectation === undefined ||
      expectation.runId !== node.runId ||
      expectation.activationId !== node.activationId ||
      expectation.forkScopeKey !== node.forkScopeKey ||
      expectation.activationKey !== node.activationKey
    ) {
      return invalid('New-node absence expectation does not match its node.');
    }
    const activation = activationIdKey(node.runId, node.activationId);
    const scope = scopedActivationKey(node);
    if (ids.has(node.id) || activations.has(activation) || scopes.has(scope)) {
      return invalid('New-node absence identities must be unique.');
    }
    ids.add(node.id);
    activations.add(activation);
    scopes.add(scope);
    if (state.nodes.has(node.id)) return conflict('REVISION_CONFLICT', 'Node id already exists.');
    for (const current of state.nodes.values()) {
      if (activationIdKey(current.runId, current.activationId) === activation) {
        return conflict('STALE_ACTIVATION', 'Node activation id already exists.');
      }
      if (scopedActivationKey(current) === scope) {
        return conflict('STALE_ACTIVATION', 'Scoped activation key already exists.');
      }
    }
  }
  return null;
};

const validRunDelta = (prior: Run, next: Run, transactionNow: number): boolean => {
  if (next.revision === prior.revision) return isDeepStrictEqual(next, prior);
  return (
    next.revision === prior.revision + 1 &&
    next.updatedAt === transactionNow &&
    next.id === prior.id &&
    isDeepStrictEqual(next.planPin, prior.planPin) &&
    isDeepStrictEqual(next.input, prior.input) &&
    isDeepStrictEqual(next.metadata, prior.metadata) &&
    next.createdAt === prior.createdAt
  );
};

const validNodeDelta = (
  prior: RunNodeInstance,
  next: RunNodeInstance,
  transactionNow: number,
): boolean => {
  if (next.revision === prior.revision) return isDeepStrictEqual(next, prior);
  return (
    next.revision === prior.revision + 1 &&
    next.updatedAt === transactionNow &&
    next.id === prior.id &&
    next.runId === prior.runId &&
    next.nodeKey === prior.nodeKey &&
    next.activationId === prior.activationId &&
    next.activationKey === prior.activationKey &&
    next.parentActivationId === prior.parentActivationId &&
    next.forkScopeKey === prior.forkScopeKey &&
    next.branchKey === prior.branchKey &&
    next.iteration === prior.iteration &&
    isDeepStrictEqual(next.activationContext, prior.activationContext) &&
    next.createdAt === prior.createdAt
  );
};

const validAttemptDelta = (prior: Attempt, next: Attempt, transactionNow: number): boolean => {
  if (next.revision === prior.revision) return isDeepStrictEqual(next, prior);
  return (
    next.revision === prior.revision + 1 &&
    next.updatedAt === transactionNow &&
    next.id === prior.id &&
    next.runId === prior.runId &&
    next.nodeInstanceId === prior.nodeInstanceId &&
    next.ordinal === prior.ordinal &&
    next.ownerLabel === prior.ownerLabel &&
    next.dispatchIdempotencyKey === prior.dispatchIdempotencyKey &&
    isDeepStrictEqual(next.executorContractPin, prior.executorContractPin) &&
    next.executorConfigurationDigest === prior.executorConfigurationDigest &&
    next.createdAt === prior.createdAt
  );
};

const validateTransitionExpectations = (
  state: LogicalRunStoreState,
  transition: DomainTransition,
  expected: RunStoreTransitionExpectations,
  transactionNow: number,
): RunStoreCommitResult | null => {
  if (!transition.changed || transition.run.id !== expected.run.runId) {
    return invalid('A committing transition must be changed and match its expected Run.');
  }
  if (!runExpectationMatches(state, expected.run)) {
    return conflict('REVISION_CONFLICT', 'Run expectation is stale.');
  }
  const priorRun = state.runs.get(transition.run.id);
  if (priorRun === undefined || !validRunDelta(priorRun, transition.run, transactionNow)) {
    return invalid('Run delta changes an immutable field, revision, or timestamp.');
  }
  for (const node of transition.nodes) {
    const prior = state.nodes.get(node.id);
    if (prior === undefined) {
      if (
        node.revision !== 0 ||
        node.createdAt !== transactionNow ||
        node.updatedAt !== transactionNow
      ) {
        return invalid('New node revision and timestamps must equal transaction time.');
      }
    } else if (!validNodeDelta(prior, node, transactionNow)) {
      return invalid('Node delta changes an immutable field, revision, or timestamp.');
    }
  }
  for (const attempt of transition.attempts) {
    const prior = state.attempts.get(attempt.id);
    if (prior === undefined) {
      if (
        attempt.revision !== 0 ||
        attempt.createdAt !== transactionNow ||
        attempt.updatedAt !== transactionNow
      ) {
        return invalid('New Attempt revision and timestamps must equal transaction time.');
      }
    } else if (!validAttemptDelta(prior, attempt, transactionNow)) {
      return invalid('Attempt delta changes an immutable field, revision, or timestamp.');
    }
  }
  if (transition.outputs.some((output) => output.createdAt !== transactionNow)) {
    return invalid('New output timestamps must equal transaction time.');
  }
  for (const attemptId of expected.absentAttemptIds) {
    if (state.attempts.has(attemptId))
      return conflict('REVISION_CONFLICT', 'Attempt id already exists.');
  }
  for (const outputId of expected.absentOutputIds) {
    if (state.outputs.has(outputId))
      return conflict('REVISION_CONFLICT', 'Output id already exists.');
  }
  if (
    transition.nodes.filter((node) => state.nodes.has(node.id)).length !== expected.nodes.length ||
    transition.attempts.filter((attempt) => state.attempts.has(attempt.id)).length !==
      expected.attempts.length ||
    transition.attempts.filter((attempt) => !state.attempts.has(attempt.id)).length !==
      expected.absentAttemptIds.length ||
    transition.outputs.length !== expected.absentOutputIds.length
  ) {
    return invalid('Transition expectation collections are incomplete.');
  }
  if (!expected.nodes.every((node) => nodeExpectationMatches(state, node))) {
    return conflict('REVISION_CONFLICT', 'Node expectation is stale.');
  }
  if (!expected.attempts.every((attempt) => attemptExpectationMatches(state, attempt))) {
    return conflict('STALE_FENCE', 'Attempt expectation is stale.');
  }
  const newNodes = transition.nodes.filter((node) => !state.nodes.has(node.id));
  return validateNewNodes(state, newNodes, expected.absentNodes);
};

const validateAuthority = (
  state: LogicalRunStoreState,
  authority: RunStoreIncumbentAuthority,
  transactionNow: number,
): RunStoreCommitResult | null => {
  const attempt = state.attempts.get(authority.attemptId);
  if (
    attempt === undefined ||
    attempt.revision !== authority.expectedAttemptRevision ||
    attempt.managerIncarnationId !== authority.managerIncarnationId ||
    attempt.fencingToken !== authority.fencingToken ||
    attempt.executorContractPin.adapterId !== authority.executorContractPin.adapterId ||
    attempt.executorContractPin.revision !== authority.executorContractPin.revision ||
    attempt.executorContractPin.digest !== authority.executorContractPin.digest ||
    attempt.executorConfigurationDigest !== authority.executorConfigurationDigest
  ) {
    return conflict('STALE_FENCE', 'Incumbent authority is stale.');
  }
  const node = state.nodes.get(attempt.nodeInstanceId);
  const run = state.runs.get(attempt.runId);
  if (
    node?.activeAttemptId !== attempt.id ||
    node.revision !== authority.expectedNodeRevision ||
    run?.revision !== authority.expectedRunRevision ||
    transactionNow >= attempt.leaseExpiresAt ||
    state.handoffs.has(
      handoffKey({ attemptId: attempt.id, incumbentFencingToken: attempt.fencingToken }),
    )
  ) {
    return conflict('STALE_FENCE', 'Incumbent fence or lease is stale.');
  }
  return null;
};

const validateIncumbentOperation = (
  state: LogicalRunStoreState,
  command: Extract<RunStoreCommitCommand, { readonly kind: 'apply_incumbent_transition' }>,
): RunStoreCommitResult | null => {
  if (command.operation === 'renew_lease') return null;
  const priorAttempt = state.attempts.get(command.authority.attemptId);
  const priorNode =
    priorAttempt === undefined ? undefined : state.nodes.get(priorAttempt.nodeInstanceId);
  const nextAttempt = command.transition.attempts[0];
  const nextNode = command.transition.nodes[0];
  if (
    priorAttempt === undefined ||
    priorNode === undefined ||
    nextAttempt === undefined ||
    nextNode === undefined
  ) {
    return invalid('Incumbent transition must contain its authoritative pair.');
  }
  const sourceExpected =
    command.operation === 'start' ||
    command.operation === 'pre_start_failure' ||
    command.operation === 'pre_start_cancellation'
      ? { attempt: 'claimed', node: 'executing' }
      : command.operation.startsWith('direct_')
        ? { attempt: 'start_committed', node: 'executing' }
        : command.operation.startsWith('late_') || command.operation === 'begin_reconciliation'
          ? { attempt: 'unknown', node: 'unknown' }
          : { attempt: 'reconciling', node: 'unknown' };
  const targetExpected =
    command.operation === 'start' || command.operation === 'reconciled_running'
      ? { attempt: 'start_committed', node: 'executing' }
      : command.operation === 'begin_reconciliation'
        ? { attempt: 'reconciling', node: 'unknown' }
        : command.operation.endsWith('_unknown')
          ? { attempt: 'unknown', node: 'unknown' }
          : command.operation.endsWith('_success')
            ? { attempt: 'succeeded', node: 'succeeded' }
            : command.operation.endsWith('_cancellation')
              ? { attempt: 'cancelled', node: 'cancelled' }
              : { attempt: 'failed', node: ['failed', 'retry_waiting'] };
  const nodeTargetMatches = Array.isArray(targetExpected.node)
    ? targetExpected.node.includes(nextNode.status)
    : nextNode.status === targetExpected.node;
  const attemptOnly =
    command.operation === 'start' ||
    command.operation === 'begin_reconciliation' ||
    command.operation === 'reconciled_unknown';
  if (
    priorAttempt.status !== sourceExpected.attempt ||
    priorNode.status !== sourceExpected.node ||
    nextAttempt.status !== targetExpected.attempt ||
    !nodeTargetMatches ||
    nextAttempt.revision !== priorAttempt.revision + 1 ||
    command.transition.run.revision !== command.expected.run.revision + (attemptOnly ? 0 : 1) ||
    nextNode.revision !== command.expected.nodes[0].revision + (attemptOnly ? 0 : 1) ||
    nextAttempt.leaseExpiresAt !== priorAttempt.leaseExpiresAt ||
    nextAttempt.lastHeartbeatAt !== priorAttempt.lastHeartbeatAt ||
    nextAttempt.fencingToken !== priorAttempt.fencingToken ||
    nextAttempt.managerIncarnationId !== priorAttempt.managerIncarnationId
  ) {
    return invalid('Incumbent operation source, result pair, revisions, or lease is invalid.');
  }
  return null;
};

const materializeEvents = (
  state: LogicalRunStoreState,
  runId: string,
  intents: readonly RunStoreEventIntent[],
  transactionNow: number,
): readonly RunStoreEvent[] => {
  const prior = state.events.get(runId) ?? [];
  return intents.map((intent, index) =>
    snapshotValue({
      ...intent,
      createdAt: transactionNow,
      cursor: { runId, sequence: prior.length + index + 1 },
      sequence: prior.length + index + 1,
    }),
  );
};

const persistTransition = (
  state: LogicalRunStoreState,
  transition: DomainTransition,
  failure: FailureHook,
): void => {
  state.runs.set(transition.run.id, snapshotValue(transition.run));
  failure('run');
  for (const node of transition.nodes) state.nodes.set(node.id, snapshotValue(node));
  failure('nodes');
  for (const attempt of transition.attempts) state.attempts.set(attempt.id, snapshotValue(attempt));
  failure('attempts');
  for (const output of transition.outputs) state.outputs.set(output.id, snapshotValue(output));
  failure('outputs');
};

const appendEvents = (
  state: LogicalRunStoreState,
  runId: string,
  events: readonly RunStoreEvent[],
  failure: FailureHook,
): void => {
  state.events.set(runId, [...(state.events.get(runId) ?? []), ...events]);
  failure('events');
};

const commitRecord = (
  state: LogicalRunStoreState,
  write: RunStoreIdempotencyWrite | null,
  transactionNow: number,
  cursor: RunEventCursor,
  failure: FailureHook,
): RunStoreIdempotencyRecord | null => {
  if (write === null) return null;
  const record = snapshotValue({ ...write, committedAt: transactionNow, cursor });
  state.idempotency.set(identityKey(write.identity), record);
  failure('idempotency');
  return record;
};

const committed = (
  state: LogicalRunStoreState,
  write: RunStoreIdempotencyWrite | null,
  transactionNow: number,
  runId: string,
  events: readonly RunStoreEvent[],
  takeover: RunStoreTakeoverResult | null = null,
  failure: FailureHook = () => undefined,
): RunStoreCommitResult => {
  appendEvents(state, runId, events, failure);
  const cursor = { runId, sequence: (state.events.get(runId) ?? []).length };
  return {
    idempotency: commitRecord(state, write, transactionNow, cursor, failure),
    kind: 'committed',
    materializedEvents: events,
    takeover,
    transactionNow,
    cursor,
  };
};

const applyCreate = (
  state: LogicalRunStoreState,
  command: Extract<RunStoreCommitCommand, { readonly kind: 'create_run' }>,
  write: RunStoreIdempotencyWrite,
  transactionNow: number,
  failure: FailureHook,
): RunStoreCommitResult => {
  if (
    command.run.id !== command.expected.absentRunId ||
    command.run.revision !== 0 ||
    command.run.createdAt !== transactionNow ||
    command.run.updatedAt !== transactionNow ||
    command.nodes.some(
      (node) =>
        node.runId !== command.run.id ||
        node.revision !== 0 ||
        node.createdAt !== transactionNow ||
        node.updatedAt !== transactionNow,
    ) ||
    command.outputs.some(
      (output) => output.runId !== command.run.id || output.createdAt !== transactionNow,
    ) ||
    command.outputs.length !== command.expected.absentOutputIds.length ||
    !command.outputs.every((output) => command.expected.absentOutputIds.includes(output.id))
  ) {
    return invalid(
      'Create Run payload, revisions, identities, or transaction timestamps are invalid.',
    );
  }
  const newNodeConflict = validateNewNodes(state, command.nodes, command.expected.absentNodes);
  if (newNodeConflict !== null) return newNodeConflict;
  if (state.runs.has(command.run.id)) return conflict('REVISION_CONFLICT', 'Run already exists.');
  if (command.outputs.some((output) => state.outputs.has(output.id))) {
    return conflict('REVISION_CONFLICT', 'Output id already exists.');
  }
  state.runs.set(command.run.id, snapshotValue(command.run));
  failure('run');
  for (const node of command.nodes) state.nodes.set(node.id, snapshotValue(node));
  failure('nodes');
  for (const output of command.outputs) state.outputs.set(output.id, snapshotValue(output));
  failure('outputs');
  const events = materializeEvents(state, command.run.id, command.eventIntents, transactionNow);
  return committed(state, write, transactionNow, command.run.id, events, null, failure);
};

const applyTransition = (
  state: LogicalRunStoreState,
  transition: DomainTransition,
  expected: RunStoreTransitionExpectations,
  write: RunStoreIdempotencyWrite | null,
  transactionNow: number,
  failure: FailureHook,
): RunStoreCommitResult => {
  const validationFailure = validateTransitionExpectations(
    state,
    transition,
    expected,
    transactionNow,
  );
  if (validationFailure !== null) return validationFailure;
  persistTransition(state, transition, failure);
  const events = materializeEvents(
    state,
    transition.run.id,
    transition.eventIntents,
    transactionNow,
  );
  return committed(state, write, transactionNow, transition.run.id, events, null, failure);
};

const applyHandoff = (
  state: LogicalRunStoreState,
  command: Extract<RunStoreCommitCommand, { readonly kind: 'write_handoff' }>,
  write: RunStoreIdempotencyWrite,
  transactionNow: number,
  failure: FailureHook,
): RunStoreCommitResult => {
  const authorityFailure = validateAuthority(state, command.authority, transactionNow);
  if (authorityFailure !== null) return authorityFailure;
  if (
    !runExpectationMatches(state, command.expected.run) ||
    !nodeExpectationMatches(state, command.expected.node) ||
    !attemptExpectationMatches(state, command.expected.attempt) ||
    command.expected.attempt.handoff.kind !== 'absent'
  ) {
    return conflict('STALE_FENCE', 'Handoff expectations are stale.');
  }
  const attempt = state.attempts.get(command.expected.attempt.attemptId);
  const node = attempt === undefined ? undefined : state.nodes.get(attempt.nodeInstanceId);
  if (attempt === undefined || node === undefined)
    return conflict('STALE_FENCE', 'Attempt is absent.');
  const key = { attemptId: attempt.id, incumbentFencingToken: attempt.fencingToken };
  const handoff: AttemptHandoff = snapshotValue({
    activationId: node.activationId,
    createdAt: transactionNow,
    expectedAttemptRevision: attempt.revision,
    id: command.handoffId,
    incumbentManagerIncarnationId: attempt.managerIncarnationId,
    key,
    nodeInstanceId: node.id,
    reason: command.reason,
    runId: attempt.runId,
  });
  state.handoffs.set(handoffKey(key), { consumption: null, handoff });
  failure('handoff');
  const intent: RunStoreEventIntent = {
    correlation: {
      activationId: node.activationId,
      attemptId: attempt.id,
      kind: 'attempt',
      nodeInstanceId: node.id,
    },
    kind: 'attempt.handoff_recorded',
    payload: {
      handoffId: handoff.id,
      incumbentFencingToken: attempt.fencingToken,
      incumbentManagerIncarnationId: attempt.managerIncarnationId,
      reason: command.reason,
    },
    runId: attempt.runId,
  };
  const events = materializeEvents(state, attempt.runId, [intent], transactionNow);
  return committed(state, write, transactionNow, attempt.runId, events, null, failure);
};

const applyAcquisition = (
  state: LogicalRunStoreState,
  command: RunStoreAcquireAttemptCommand,
  write: RunStoreIdempotencyWrite,
  transactionNow: number,
  failure: FailureHook,
): RunStoreCommitResult => {
  if (!validLeasePolicy(transactionNow, command.leasePolicy)) {
    return invalid('Acquisition LeasePolicy is invalid.');
  }
  const oldAttempt = state.attempts.get(command.expected.attempt.attemptId);
  const oldNode = state.nodes.get(command.expected.node.nodeInstanceId);
  const oldRun = state.runs.get(command.expected.run.runId);
  if (
    oldAttempt === undefined ||
    oldNode === undefined ||
    oldRun === undefined ||
    !runExpectationMatches(state, command.expected.run) ||
    !nodeExpectationMatches(state, command.expected.node) ||
    !attemptExpectationMatches(state, command.expected.attempt)
  ) {
    return conflict('STALE_FENCE', 'Acquisition expectation is stale.');
  }
  const expectedHandoff = command.expected.attempt.handoff;
  const handoffState = state.handoffs.get(handoffKey(expectedHandoff.key));
  if (
    (command.evidence.kind === 'lease_expired' &&
      (expectedHandoff.kind !== 'absent' ||
        handoffState !== undefined ||
        transactionNow < oldAttempt.leaseExpiresAt)) ||
    (command.evidence.kind === 'handoff' &&
      (expectedHandoff.kind !== 'named' ||
        expectedHandoff.handoffId !== command.evidence.handoffId ||
        handoffState?.handoff.id !== command.evidence.handoffId ||
        handoffState.consumption !== null))
  ) {
    return conflict('STALE_FENCE', 'Takeover evidence is stale or already consumed.');
  }
  const next = command.change.attempt;
  if (
    command.change.run.id !== oldRun.id ||
    command.change.node.id !== oldNode.id ||
    next.id !== oldAttempt.id ||
    command.successorManagerIncarnationId === oldAttempt.managerIncarnationId ||
    next.managerIncarnationId !== command.successorManagerIncarnationId ||
    next.fencingToken !== oldAttempt.fencingToken + 1 ||
    next.revision !== oldAttempt.revision + 1 ||
    next.lastHeartbeatAt !== transactionNow ||
    next.updatedAt !== transactionNow ||
    next.leaseExpiresAt !== transactionNow + command.leasePolicy.leaseDurationMs ||
    !validAttemptDelta(oldAttempt, next, transactionNow) ||
    next.startCommittedAt !== oldAttempt.startCommittedAt ||
    next.terminalAt !== oldAttempt.terminalAt
  ) {
    return invalid('Lifecycle-supplied takeover change is invalid.');
  }
  if (
    !validRunDelta(oldRun, command.change.run, transactionNow) ||
    !validNodeDelta(oldNode, command.change.node, transactionNow)
  ) {
    return invalid('Takeover changes an immutable field, revision, or timestamp.');
  }
  const unknownFaultIsBounded =
    next.fault?.code === 'UNKNOWN_OUTCOME' &&
    next.fault.message.length > 0 &&
    Buffer.byteLength(next.fault.message) <= 1_024;
  const validPair =
    (oldAttempt.status === 'claimed' &&
      oldNode.status === 'executing' &&
      next.status === 'claimed' &&
      command.change.node.status === 'executing' &&
      isDeepStrictEqual(command.change.run, oldRun) &&
      isDeepStrictEqual(command.change.node, oldNode) &&
      isDeepStrictEqual(next.fault, oldAttempt.fault)) ||
    (oldAttempt.status === 'start_committed' &&
      oldNode.status === 'executing' &&
      next.status === 'unknown' &&
      command.change.node.status === 'unknown' &&
      isDeepStrictEqual(command.change.run, {
        ...oldRun,
        revision: oldRun.revision + 1,
        updatedAt: transactionNow,
      }) &&
      isDeepStrictEqual(command.change.node, {
        ...oldNode,
        revision: oldNode.revision + 1,
        status: 'unknown',
        updatedAt: transactionNow,
      }) &&
      unknownFaultIsBounded) ||
    ((oldAttempt.status === 'unknown' || oldAttempt.status === 'reconciling') &&
      oldNode.status === 'unknown' &&
      next.status === 'unknown' &&
      command.change.node.status === 'unknown' &&
      isDeepStrictEqual(command.change.run, oldRun) &&
      isDeepStrictEqual(command.change.node, oldNode) &&
      isDeepStrictEqual(next.fault, oldAttempt.fault));
  if (!validPair) return invalid('Takeover state pair or revisions are invalid.');
  let consumption: AttemptHandoffConsumption | null = null;
  if (command.evidence.kind === 'handoff' && handoffState !== undefined) {
    consumption = snapshotValue({
      consumedAt: transactionNow,
      handoffId: handoffState.handoff.id,
      key: handoffState.handoff.key,
      successorFencingToken: next.fencingToken,
      successorManagerIncarnationId: next.managerIncarnationId,
    });
    state.handoffs.set(handoffKey(handoffState.handoff.key), {
      consumption,
      handoff: handoffState.handoff,
    });
    failure('handoff_consumption');
  }
  state.runs.set(oldRun.id, snapshotValue(command.change.run));
  failure('run');
  state.nodes.set(oldNode.id, snapshotValue(command.change.node));
  failure('nodes');
  state.attempts.set(oldAttempt.id, snapshotValue(next));
  failure('attempts');
  const correlation = {
    activationId: oldNode.activationId,
    attemptId: oldAttempt.id,
    kind: 'attempt' as const,
    nodeInstanceId: oldNode.id,
  };
  const payloadBase = {
    fromAttemptStatus: oldAttempt.status,
    fromNodeStatus: oldNode.status,
    previousFencingToken: oldAttempt.fencingToken,
    previousManagerIncarnationId: oldAttempt.managerIncarnationId,
    successorFencingToken: next.fencingToken,
    successorManagerIncarnationId: next.managerIncarnationId,
    toAttemptStatus: next.status,
    toNodeStatus: command.change.node.status,
  };
  const intent: RunStoreEventIntent =
    command.evidence.kind === 'lease_expired'
      ? {
          correlation,
          kind: 'attempt.ownership_acquired',
          payload: {
            ...payloadBase,
            evidence: 'lease_expired',
            handoffId: null,
          },
          runId: oldRun.id,
        }
      : {
          correlation,
          kind: 'attempt.ownership_acquired',
          payload: {
            ...payloadBase,
            evidence: 'handoff',
            handoffId: command.evidence.handoffId,
          },
          runId: oldRun.id,
        };
  const events = materializeEvents(state, oldRun.id, [intent], transactionNow);
  let takeover: RunStoreTakeoverResult;
  if (command.evidence.kind === 'lease_expired') {
    takeover = {
      attempt: snapshotValue(next),
      evidence: 'lease_expired',
      handoffConsumption: null,
      node: snapshotValue(command.change.node),
      run: snapshotValue(command.change.run),
    };
  } else if (consumption === null) {
    return invalid('Handoff acquisition did not materialize consumption.');
  } else {
    takeover = {
      attempt: snapshotValue(next),
      evidence: 'handoff',
      handoffConsumption: consumption,
      node: snapshotValue(command.change.node),
      run: snapshotValue(command.change.run),
    };
  }
  return committed(state, write, transactionNow, oldRun.id, events, takeover, failure);
};

export const applyLogicalRunStoreCommit = (
  state: LogicalRunStoreState,
  command: RunStoreCommitCommand,
  transactionNow: number,
  failure: FailureHook = () => undefined,
): RunStoreCommitResult => {
  const preflight = preflightCommand(command, transactionNow);
  if (preflight !== null) return preflight;
  const idempotency = validateIdempotency(state, command);
  if (idempotency.kind === 'result') return idempotency.result;
  if (command.kind === 'create_run') {
    if (idempotency.write === null) return invalid('Create Run requires idempotency.');
    return applyCreate(state, command, idempotency.write, transactionNow, failure);
  }
  if (command.kind === 'claim_attempt') {
    if (!validLeasePolicy(transactionNow, command.leasePolicy)) {
      return invalid('Claim LeasePolicy is invalid.');
    }
    if (state.attempts.has(command.expected.absentAttemptId)) {
      return conflict('REVISION_CONFLICT', 'Attempt id already exists.');
    }
    const claimedAttempt = command.transition.attempts.find(
      (attempt) => attempt.id === command.expected.absentAttemptId,
    );
    const claimedNode = command.transition.nodes.find(
      (node) => node.id === command.expected.node.nodeInstanceId,
    );
    if (
      claimedAttempt === undefined ||
      claimedNode === undefined ||
      claimedAttempt.status !== 'claimed' ||
      claimedAttempt.revision !== 0 ||
      claimedAttempt.fencingToken !== 1 ||
      claimedAttempt.lastHeartbeatAt !== transactionNow ||
      claimedAttempt.updatedAt !== transactionNow ||
      claimedAttempt.createdAt !== transactionNow ||
      claimedAttempt.leaseExpiresAt !== transactionNow + command.leasePolicy.leaseDurationMs ||
      claimedNode.activeAttemptId !== claimedAttempt.id ||
      claimedNode.status !== 'executing' ||
      command.transition.eventIntents.length !== 2 ||
      command.transition.eventIntents[0]?.kind !== 'attempt.created' ||
      command.transition.eventIntents[1]?.kind !== 'node.transitioned'
    ) {
      return invalid('Claim transition, fence, pointer, or DB-time lease is invalid.');
    }
    return applyTransition(
      state,
      command.transition,
      claimExpectations(command),
      idempotency.write,
      transactionNow,
      failure,
    );
  }
  if (command.kind === 'apply_unowned_transition') {
    return applyTransition(
      state,
      command.transition,
      command.expected,
      idempotency.write,
      transactionNow,
      failure,
    );
  }
  if (command.kind === 'apply_incumbent_transition') {
    const authorityFailure = validateAuthority(state, command.authority, transactionNow);
    if (authorityFailure !== null) return authorityFailure;
    const operationFailure = validateIncumbentOperation(state, command);
    if (operationFailure !== null) return operationFailure;
    if (command.operation === 'renew_lease') {
      if (!validLeasePolicy(transactionNow, command.leasePolicy)) {
        return invalid('Renewal LeasePolicy is invalid.');
      }
      const prior = state.attempts.get(command.authority.attemptId);
      const next = command.transition.attempts[0];
      const priorRun = state.runs.get(command.expected.run.runId);
      const priorNode = state.nodes.get(command.expected.nodes[0].nodeInstanceId);
      if (
        prior === undefined ||
        priorRun === undefined ||
        priorNode === undefined ||
        next === undefined ||
        command.idempotency !== null ||
        !isDeepStrictEqual(command.transition.run, priorRun) ||
        !isDeepStrictEqual(command.transition.nodes[0], priorNode) ||
        command.transition.outputs.length !== 0 ||
        command.transition.eventIntents.length !== 0 ||
        next.id !== prior.id ||
        next.revision !== prior.revision + 1 ||
        next.status !== prior.status ||
        next.lastHeartbeatAt !== transactionNow ||
        next.updatedAt !== transactionNow ||
        next.leaseExpiresAt !== transactionNow + command.leasePolicy.leaseDurationMs ||
        next.managerIncarnationId !== prior.managerIncarnationId ||
        next.fencingToken !== prior.fencingToken ||
        next.ownerLabel !== prior.ownerLabel ||
        next.ordinal !== prior.ordinal ||
        next.dispatchIdempotencyKey !== prior.dispatchIdempotencyKey ||
        next.executorConfigurationDigest !== prior.executorConfigurationDigest ||
        !isDeepStrictEqual(next.executorContractPin, prior.executorContractPin) ||
        next.createdAt !== prior.createdAt ||
        next.startCommittedAt !== prior.startCommittedAt ||
        next.terminalAt !== prior.terminalAt ||
        !isDeepStrictEqual(next.fault, prior.fault)
      ) {
        return invalid('Renewal transition is invalid.');
      }
    }
    return applyTransition(
      state,
      command.transition,
      {
        ...command.expected,
        attempts: command.expected.attempts,
        nodes: command.expected.nodes,
      },
      idempotency.write,
      transactionNow,
      failure,
    );
  }
  if (command.kind === 'write_handoff') {
    if (idempotency.write === null) return invalid('Handoff requires idempotency.');
    return applyHandoff(state, command, idempotency.write, transactionNow, failure);
  }
  if (idempotency.write === null) return invalid('Acquisition requires idempotency.');
  return applyAcquisition(state, command, idempotency.write, transactionNow, failure);
};
