import type { RunFault } from '../errors/index.js';
import type { ExecutorContractPin } from '../spec/index.js';
import type { AttemptStatus } from './attempt-status.js';
import type { Attempt } from './attempt.js';
import { createAttempt } from './create-attempt.js';
import { createRunNodeInstance } from './create-run-node-instance.js';
import { createRunOutput } from './create-run-output.js';
import { createRun } from './create-run.js';
import type { DomainAuthority } from './domain-authority.js';
import { domainEvents } from './domain-events.js';
import type { DomainOperation } from './domain-operation.js';
import type { DomainTransition } from './domain-transition.js';
import { domainValidation } from './domain-validation.js';
import type { RunEventIntent } from './run-event-intent.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunNodeStatus } from './run-node-status.js';
import type { RunOutput } from './run-output.js';
import type { Run } from './run.js';
import { validateRunAggregate } from './validate-run-aggregate.js';

type Operation<Kind extends DomainOperation['kind']> = Extract<
  DomainOperation,
  { readonly kind: Kind }
>;

const transition = (
  run: Run,
  nodes: readonly RunNodeInstance[],
  attempts: readonly Attempt[],
  outputs: readonly RunOutput[],
  eventIntents: readonly RunEventIntent[],
  changed = true,
): DomainTransition => {
  validateRunAggregate({ attempts, nodes, run });
  return Object.freeze({
    attempts: Object.freeze([...attempts]),
    changed,
    eventIntents: Object.freeze([...eventIntents]),
    nodes: Object.freeze([...nodes]),
    outputs: Object.freeze([...outputs]),
    run,
  });
};

const samePin = (left: ExecutorContractPin, right: ExecutorContractPin): boolean =>
  left.adapterId === right.adapterId &&
  left.revision === right.revision &&
  left.digest === right.digest;

const assertPairIdentity = (run: Run, node: RunNodeInstance, attempt: Attempt): void => {
  if (
    node.runId !== run.id ||
    attempt.runId !== run.id ||
    attempt.nodeInstanceId !== node.id ||
    node.activeAttemptId !== attempt.id
  ) {
    throw new TypeError('STALE_FENCE');
  }
  validateRunAggregate({ attempts: [attempt], nodes: [node], run });
};

const assertAuthority = (
  run: Run,
  node: RunNodeInstance,
  attempt: Attempt,
  authority: DomainAuthority,
): void => {
  assertPairIdentity(run, node, attempt);
  const transactionNow = domainValidation.nonnegativeInteger(authority.transactionNow);
  if (
    authority.expectedRunRevision !== run.revision ||
    authority.expectedNodeRevision !== node.revision ||
    authority.expectedAttemptRevision !== attempt.revision
  ) {
    throw new TypeError('REVISION_CONFLICT');
  }
  if (
    authority.attemptId !== attempt.id ||
    authority.managerIncarnationId !== attempt.managerIncarnationId ||
    authority.fencingToken !== attempt.fencingToken
  ) {
    throw new TypeError('STALE_FENCE');
  }
  if (
    authority.executorConfigurationDigest !== attempt.executorConfigurationDigest ||
    !samePin(authority.executorContractPin, attempt.executorContractPin)
  ) {
    throw new TypeError('INVALID_STATE');
  }
  if (
    transactionNow < run.updatedAt ||
    transactionNow < node.updatedAt ||
    transactionNow < attempt.updatedAt ||
    transactionNow >= attempt.leaseExpiresAt
  ) {
    throw new TypeError('STALE_FENCE');
  }
};

const assertPair = (
  node: RunNodeInstance,
  attempt: Attempt,
  nodeStatus: RunNodeStatus,
  attemptStatus: AttemptStatus,
): void => {
  if (node.status !== nodeStatus || attempt.status !== attemptStatus) {
    throw new TypeError('INVALID_STATE');
  }
};

const assertTransactionTime = (
  transactionNow: number,
  ...entities: readonly { readonly updatedAt: number }[]
): void => {
  const now = domainValidation.nonnegativeInteger(transactionNow);
  if (entities.some((entity) => now < entity.updatedAt)) {
    throw new TypeError('INVALID_STATE');
  }
};

const incrementRun = (run: Run, updatedAt: number): Run =>
  createRun({
    ...run,
    revision: domainValidation.incrementRevision(run.revision),
    updatedAt,
  });

const transitionNode = (
  node: RunNodeInstance,
  status: RunNodeStatus,
  updatedAt: number,
  options: {
    readonly activeAttemptId: string | null;
    readonly retryAvailableAt?: number | null;
    readonly terminalFault?: RunFault | null;
  },
): RunNodeInstance =>
  createRunNodeInstance({
    ...node,
    activeAttemptId: options.activeAttemptId,
    retryAvailableAt: options.retryAvailableAt ?? null,
    revision: domainValidation.incrementRevision(node.revision),
    status,
    terminalAt:
      status === 'succeeded' || status === 'failed' || status === 'cancelled' ? updatedAt : null,
    terminalFault: options.terminalFault ?? null,
    updatedAt,
  });

const transitionAttempt = (
  attempt: Attempt,
  status: AttemptStatus,
  updatedAt: number,
  options: {
    readonly fault?: RunFault | null;
    readonly startCommittedAt?: number | null;
  } = {},
): Attempt =>
  createAttempt({
    ...attempt,
    fault: options.fault ?? null,
    revision: domainValidation.incrementRevision(attempt.revision),
    startCommittedAt: options.startCommittedAt ?? attempt.startCommittedAt,
    status,
    terminalAt:
      status === 'succeeded' || status === 'failed' || status === 'cancelled' ? updatedAt : null,
    updatedAt,
  });

const verifyExpectedRevisions = (
  run: Run,
  node: RunNodeInstance,
  expectedRunRevision: number,
  expectedNodeRevision: number,
): void => {
  if (run.revision !== expectedRunRevision || node.revision !== expectedNodeRevision) {
    throw new TypeError('REVISION_CONFLICT');
  }
};

const validateOutputs = (
  outputs: readonly RunOutput[],
  run: Run,
  node: RunNodeInstance,
  attempt: Attempt,
  transactionNow: number,
): readonly RunOutput[] => {
  const snapshots = outputs.map((output) => createRunOutput(output));
  const ids = new Set<string>();
  for (const output of snapshots) {
    const correlation = output.correlation;
    const nodeMatches =
      correlation.kind === 'run' ||
      (correlation.nodeInstanceId === node.id && correlation.activationId === node.activationId);
    const attemptMatches = correlation.kind !== 'attempt' || correlation.attemptId === attempt.id;
    if (
      output.runId !== run.id ||
      output.createdAt !== transactionNow ||
      ids.has(output.id) ||
      !nodeMatches ||
      !attemptMatches
    ) {
      throw new TypeError('Run output correlation is invalid.');
    }
    ids.add(output.id);
  }
  return Object.freeze(snapshots);
};

const claim = (operation: Operation<'claim'>): DomainTransition => {
  assertTransactionTime(operation.transactionNow, operation.run, operation.node, operation.attempt);
  verifyExpectedRevisions(
    operation.run,
    operation.node,
    operation.expectedRunRevision,
    operation.expectedNodeRevision,
  );
  if (
    operation.run.status !== 'running' ||
    (operation.node.status !== 'ready' && operation.node.status !== 'retry_waiting') ||
    operation.node.activeAttemptId !== null ||
    operation.node.runId !== operation.run.id ||
    operation.attempt.runId !== operation.run.id ||
    operation.attempt.nodeInstanceId !== operation.node.id ||
    operation.attempt.status !== 'claimed' ||
    operation.attempt.revision !== 0 ||
    operation.attempt.createdAt !== operation.transactionNow ||
    operation.attempt.updatedAt !== operation.transactionNow ||
    operation.attempt.lastHeartbeatAt !== operation.transactionNow ||
    operation.transactionNow >= operation.attempt.leaseExpiresAt
  ) {
    throw new TypeError('Claim input is invalid.');
  }
  domainValidation.incrementRevision(operation.run.revision);
  domainValidation.incrementRevision(operation.node.revision);
  const node = transitionNode(operation.node, 'executing', operation.transactionNow, {
    activeAttemptId: operation.attempt.id,
  });
  const run = incrementRun(operation.run, operation.transactionNow);
  validateRunAggregate({ attempts: [operation.attempt], nodes: [node], run });
  return transition(
    run,
    [node],
    [operation.attempt],
    [],
    [
      domainEvents.attemptCreated(node, operation.attempt),
      domainEvents.nodeTransitioned(node, operation.node.status, 'claimed'),
    ],
  );
};

const start = (operation: Operation<'start'>): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, 'executing', 'claimed');
  const attempt = transitionAttempt(
    operation.attempt,
    'start_committed',
    operation.authority.transactionNow,
    { startCommittedAt: operation.authority.transactionNow },
  );
  return transition(
    operation.run,
    [operation.node],
    [attempt],
    [],
    [
      domainEvents.attemptTransitioned(operation.node, attempt, {
        cause: 'start',
        from: 'claimed',
        to: 'start_committed',
      }),
    ],
  );
};

const renewLease = (operation: Operation<'renew_lease'>): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  if (
    !(
      (operation.node.status === 'executing' &&
        (operation.attempt.status === 'claimed' ||
          operation.attempt.status === 'start_committed')) ||
      (operation.node.status === 'unknown' &&
        (operation.attempt.status === 'unknown' || operation.attempt.status === 'reconciling'))
    )
  ) {
    throw new TypeError('INVALID_STATE');
  }
  if (
    operation.nextLastHeartbeatAt !== operation.authority.transactionNow ||
    operation.nextLeaseExpiresAt <= operation.authority.transactionNow
  ) {
    throw new TypeError('Lease renewal values are invalid.');
  }
  const attempt = createAttempt({
    ...operation.attempt,
    lastHeartbeatAt: operation.nextLastHeartbeatAt,
    leaseExpiresAt: operation.nextLeaseExpiresAt,
    revision: domainValidation.incrementRevision(operation.attempt.revision),
    updatedAt: operation.authority.transactionNow,
  });
  return transition(operation.run, [operation.node], [attempt], [], []);
};

const failure = (
  operation:
    | Operation<'pre_start_failure'>
    | Operation<'direct_failure'>
    | Operation<'late_failure'>
    | Operation<'reconciled_failure'>,
  expectedNodeStatus: RunNodeStatus,
  expectedAttemptStatus: AttemptStatus,
  cause: 'pre_start_resolution_failure' | 'direct_failure' | 'late_failure' | 'reconciled_failure',
): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, expectedNodeStatus, expectedAttemptStatus);
  const now = operation.authority.transactionNow;
  if (
    operation.retryAvailableAt !== null &&
    domainValidation.nonnegativeInteger(operation.retryAvailableAt) < now
  ) {
    throw new TypeError('Retry availability precedes transaction time.');
  }
  const retryScheduled = operation.retryAvailableAt !== null;
  const node = transitionNode(operation.node, retryScheduled ? 'retry_waiting' : 'failed', now, {
    activeAttemptId: null,
    retryAvailableAt: operation.retryAvailableAt,
    terminalFault: retryScheduled ? null : operation.fault,
  });
  const attempt = transitionAttempt(operation.attempt, 'failed', now, {
    fault: operation.fault,
  });
  const run = incrementRun(operation.run, now);
  return transition(
    run,
    [node],
    [attempt],
    [],
    [
      domainEvents.attemptTransitioned(
        node,
        attempt,
        failureEventPayload(cause, attempt.fault?.code ?? 'INVALID_STATE', retryScheduled),
      ),
      domainEvents.nodeTransitioned(node, operation.node.status, cause),
    ],
  );
};

const failureEventPayload = (
  cause: 'pre_start_resolution_failure' | 'direct_failure' | 'late_failure' | 'reconciled_failure',
  faultCode: RunFault['code'],
  retryScheduled: boolean,
) => {
  switch (cause) {
    case 'pre_start_resolution_failure':
      return Object.freeze({
        cause,
        faultCode,
        from: 'claimed',
        retryScheduled,
        to: 'failed',
      });
    case 'direct_failure':
      return Object.freeze({
        cause,
        faultCode,
        from: 'start_committed',
        retryScheduled,
        to: 'failed',
      });
    case 'late_failure':
      return Object.freeze({
        cause,
        faultCode,
        from: 'unknown',
        retryScheduled,
        to: 'failed',
      });
    case 'reconciled_failure':
      return Object.freeze({
        cause,
        faultCode,
        from: 'reconciling',
        retryScheduled,
        to: 'failed',
      });
  }
  throw new TypeError('Failure event cause is invalid.');
};

const cancellation = (
  operation:
    | Operation<'pre_start_cancellation'>
    | Operation<'direct_cancellation'>
    | Operation<'late_cancellation'>
    | Operation<'reconciled_cancellation'>,
  expectedNodeStatus: RunNodeStatus,
  expectedAttemptStatus: 'claimed' | 'start_committed' | 'unknown' | 'reconciling',
  cause:
    | 'pre_start_cancellation'
    | 'direct_cancellation'
    | 'late_cancellation'
    | 'reconciled_cancellation',
): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, expectedNodeStatus, expectedAttemptStatus);
  const now = operation.authority.transactionNow;
  const node = transitionNode(operation.node, 'cancelled', now, {
    activeAttemptId: null,
  });
  const attempt = transitionAttempt(operation.attempt, 'cancelled', now);
  const run = incrementRun(operation.run, now);
  return transition(
    run,
    [node],
    [attempt],
    [],
    [
      domainEvents.attemptTransitioned(node, attempt, cancellationEventPayload(cause)),
      domainEvents.nodeTransitioned(node, operation.node.status, cause),
    ],
  );
};

const cancellationEventPayload = (
  cause:
    | 'pre_start_cancellation'
    | 'direct_cancellation'
    | 'late_cancellation'
    | 'reconciled_cancellation',
) => {
  switch (cause) {
    case 'pre_start_cancellation':
      return Object.freeze({ cause, from: 'claimed', to: 'cancelled' });
    case 'direct_cancellation':
      return Object.freeze({ cause, from: 'start_committed', to: 'cancelled' });
    case 'late_cancellation':
      return Object.freeze({ cause, from: 'unknown', to: 'cancelled' });
    case 'reconciled_cancellation':
      return Object.freeze({ cause, from: 'reconciling', to: 'cancelled' });
  }
  throw new TypeError('Cancellation event cause is invalid.');
};

const success = (
  operation:
    | Operation<'direct_success'>
    | Operation<'late_success'>
    | Operation<'reconciled_success'>,
  expectedNodeStatus: RunNodeStatus,
  expectedAttemptStatus: 'start_committed' | 'unknown' | 'reconciling',
  cause: 'direct_success' | 'late_success' | 'reconciled_success',
): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, expectedNodeStatus, expectedAttemptStatus);
  const now = operation.authority.transactionNow;
  const outputs = validateOutputs(
    operation.outputs,
    operation.run,
    operation.node,
    operation.attempt,
    now,
  );
  const node = transitionNode(operation.node, 'succeeded', now, {
    activeAttemptId: null,
  });
  const attempt = transitionAttempt(operation.attempt, 'succeeded', now);
  const run = incrementRun(operation.run, now);
  return transition(run, [node], [attempt], outputs, [
    domainEvents.attemptTransitioned(node, attempt, successEventPayload(cause)),
    ...outputs.map((output) => domainEvents.outputRecorded(output)),
    domainEvents.nodeTransitioned(node, operation.node.status, cause),
  ]);
};

const successEventPayload = (cause: 'direct_success' | 'late_success' | 'reconciled_success') => {
  switch (cause) {
    case 'direct_success':
      return Object.freeze({ cause, from: 'start_committed', to: 'succeeded' });
    case 'late_success':
      return Object.freeze({ cause, from: 'unknown', to: 'succeeded' });
    case 'reconciled_success':
      return Object.freeze({ cause, from: 'reconciling', to: 'succeeded' });
  }
  throw new TypeError('Success event cause is invalid.');
};

const directUnknown = (operation: Operation<'direct_unknown'>): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, 'executing', 'start_committed');
  if (operation.fault.code !== 'UNKNOWN_OUTCOME') {
    throw new TypeError('Unknown outcome requires UNKNOWN_OUTCOME fault.');
  }
  const now = operation.authority.transactionNow;
  const node = transitionNode(operation.node, 'unknown', now, {
    activeAttemptId: operation.attempt.id,
  });
  const attempt = transitionAttempt(operation.attempt, 'unknown', now, {
    fault: operation.fault,
  });
  const run = incrementRun(operation.run, now);
  return transition(
    run,
    [node],
    [attempt],
    [],
    [
      domainEvents.attemptTransitioned(node, attempt, {
        cause: 'direct_unknown',
        faultCode: 'UNKNOWN_OUTCOME',
        from: 'start_committed',
        to: 'unknown',
      }),
      domainEvents.nodeTransitioned(node, operation.node.status, 'direct_unknown'),
    ],
  );
};

const beginReconciliation = (operation: Operation<'begin_reconciliation'>): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, 'unknown', 'unknown');
  const attempt = transitionAttempt(
    operation.attempt,
    'reconciling',
    operation.authority.transactionNow,
    { fault: operation.attempt.fault },
  );
  return transition(
    operation.run,
    [operation.node],
    [attempt],
    [],
    [
      domainEvents.attemptTransitioned(operation.node, attempt, {
        cause: 'reconciliation_started',
        from: 'unknown',
        to: 'reconciling',
      }),
    ],
  );
};

const reconciledUnknown = (operation: Operation<'reconciled_unknown'>): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, 'unknown', 'reconciling');
  const attempt = transitionAttempt(
    operation.attempt,
    'unknown',
    operation.authority.transactionNow,
    { fault: operation.attempt.fault },
  );
  return transition(
    operation.run,
    [operation.node],
    [attempt],
    [],
    [
      domainEvents.attemptTransitioned(operation.node, attempt, {
        cause: 'reconciled_unknown',
        from: 'reconciling',
        to: 'unknown',
      }),
    ],
  );
};

const reconciledRunning = (operation: Operation<'reconciled_running'>): DomainTransition => {
  assertAuthority(operation.run, operation.node, operation.attempt, operation.authority);
  assertPair(operation.node, operation.attempt, 'unknown', 'reconciling');
  const now = operation.authority.transactionNow;
  const node = transitionNode(operation.node, 'executing', now, {
    activeAttemptId: operation.attempt.id,
  });
  const attempt = transitionAttempt(operation.attempt, 'start_committed', now, {
    fault: null,
  });
  const run = incrementRun(operation.run, now);
  return transition(
    run,
    [node],
    [attempt],
    [],
    [
      domainEvents.attemptTransitioned(node, attempt, {
        cause: 'reconciled_running',
        from: 'reconciling',
        to: 'start_committed',
      }),
      domainEvents.nodeTransitioned(node, operation.node.status, 'reconciled_running'),
    ],
  );
};

const activateNodes = (operation: Operation<'activate_nodes'>): DomainTransition => {
  assertTransactionTime(operation.transactionNow, operation.run);
  if (operation.run.status !== 'running') {
    throw new TypeError('Only a running Run can activate nodes.');
  }
  domainValidation.incrementRevision(operation.run.revision);
  const identities = new Set<string>();
  for (const node of operation.nodes) {
    const identity = `${node.forkScopeKey}\u0000${node.activationKey}`;
    if (
      node.runId !== operation.run.id ||
      node.revision !== 0 ||
      node.createdAt !== operation.transactionNow ||
      node.updatedAt !== operation.transactionNow ||
      node.activeAttemptId !== null ||
      (node.status !== 'ready' &&
        node.status !== 'gate_waiting' &&
        node.status !== 'join_waiting') ||
      identities.has(identity)
    ) {
      throw new TypeError('Node activation input is invalid.');
    }
    identities.add(identity);
  }
  if (operation.nodes.length === 0) {
    return transition(operation.run, [], [], [], [], false);
  }
  const run = incrementRun(operation.run, operation.transactionNow);
  validateRunAggregate({ attempts: [], nodes: operation.nodes, run });
  return transition(
    run,
    operation.nodes,
    [],
    [],
    operation.nodes.map((node) => domainEvents.activated(node)),
  );
};

const requestCancellation = (operation: Operation<'request_cancellation'>): DomainTransition => {
  assertTransactionTime(
    operation.transactionNow,
    operation.run,
    ...operation.nodes,
    ...operation.attempts,
  );
  validateRunAggregate({
    attempts: operation.attempts,
    nodes: operation.nodes,
    run: operation.run,
  });
  if (operation.run.status === 'cancelling') {
    return transition(operation.run, operation.nodes, operation.attempts, [], [], false);
  }
  if (operation.run.status !== 'running') {
    throw new TypeError('Terminal Run cannot request cancellation.');
  }
  domainValidation.incrementRevision(operation.run.revision);
  const changed: Array<{ readonly before: RunNodeInstance; readonly after: RunNodeInstance }> = [];
  const nodes = operation.nodes.map((node) => {
    if (
      node.status === 'ready' ||
      node.status === 'retry_waiting' ||
      node.status === 'gate_waiting' ||
      node.status === 'join_waiting'
    ) {
      domainValidation.incrementRevision(node.revision);
      const after = transitionNode(node, 'cancelled', operation.transactionNow, {
        activeAttemptId: null,
      });
      changed.push({ after, before: node });
      return after;
    }
    return node;
  });
  const run = createRun({
    ...operation.run,
    cancellationRequestedAt: operation.transactionNow,
    revision: domainValidation.incrementRevision(operation.run.revision),
    status: 'cancelling',
    updatedAt: operation.transactionNow,
  });
  const orderedNodeEvents = changed
    .toSorted((left, right) => left.after.id.localeCompare(right.after.id))
    .map(({ after, before }) =>
      domainEvents.nodeTransitioned(after, before.status, 'cancellation_requested'),
    );
  validateRunAggregate({ attempts: operation.attempts, nodes, run });
  return transition(
    run,
    nodes,
    operation.attempts,
    [],
    [domainEvents.cancellationRequested(run), ...orderedNodeEvents],
  );
};

const gateAnswer = (operation: Operation<'gate_answer'>): DomainTransition => {
  assertTransactionTime(operation.transactionNow, operation.run, operation.node);
  verifyExpectedRevisions(
    operation.run,
    operation.node,
    operation.expectedRunRevision,
    operation.expectedNodeRevision,
  );
  if (
    operation.node.runId !== operation.run.id ||
    operation.node.status !== 'gate_waiting' ||
    operation.node.activeAttemptId !== null
  ) {
    throw new TypeError('Gate answer source is invalid.');
  }
  const output = createRunOutput(operation.output);
  if (
    output.runId !== operation.run.id ||
    output.createdAt !== operation.transactionNow ||
    output.correlation.kind !== 'node' ||
    output.correlation.nodeInstanceId !== operation.node.id ||
    output.correlation.activationId !== operation.node.activationId
  ) {
    throw new TypeError('Gate answer correlation is invalid.');
  }
  const node = transitionNode(operation.node, 'succeeded', operation.transactionNow, {
    activeAttemptId: null,
  });
  return transition(
    incrementRun(operation.run, operation.transactionNow),
    [node],
    [],
    [output],
    [],
  );
};

const joinTransition = (
  operation: Operation<'join_ready'> | Operation<'join_succeeded'>,
): DomainTransition => {
  assertTransactionTime(operation.transactionNow, operation.run, operation.node);
  verifyExpectedRevisions(
    operation.run,
    operation.node,
    operation.expectedRunRevision,
    operation.expectedNodeRevision,
  );
  if (
    operation.node.runId !== operation.run.id ||
    operation.node.status !== 'join_waiting' ||
    operation.node.activeAttemptId !== null
  ) {
    throw new TypeError('Join prospective source is invalid.');
  }
  const node = transitionNode(
    operation.node,
    operation.kind === 'join_ready' ? 'ready' : 'succeeded',
    operation.transactionNow,
    { activeAttemptId: null },
  );
  return transition(incrementRun(operation.run, operation.transactionNow), [node], [], [], []);
};

export const domainReducers = Object.freeze({
  activateNodes,
  beginReconciliation,
  cancellation,
  claim,
  directUnknown,
  failure,
  gateAnswer,
  joinTransition,
  reconciledRunning,
  reconciledUnknown,
  renewLease,
  requestCancellation,
  start,
  success,
});
