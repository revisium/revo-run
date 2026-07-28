import {
  applyDomainOperation,
  createAttempt,
  createRun,
  createRunNodeInstance,
  createRunOutput,
  deriveActivationKey,
  deriveRootForkScopeKey,
} from '../../src/domain/index.js';
import type {
  Attempt,
  AttemptStatus,
  DomainTransition,
  Run,
  RunNodeInstance,
  RunNodeStatus,
  RunOutput,
} from '../../src/domain/index.js';
import type {
  RunStoreAttemptExpectation,
  RunStoreIdempotencyOperation,
  RunStoreIdempotencyWrite,
  RunStoreNodeExpectation,
  RunStoreRunExpectation,
} from '../../src/storage/index.js';

export const planPin = { digest: 'plan-digest', id: 'plan', revision: '1' };
export const executorPin = {
  adapterId: 'executor',
  digest: 'executor-digest',
  revision: '1',
};
export const configurationDigest =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

export const runFixture = (overrides: Partial<Run> = {}): Run =>
  createRun({
    cancellationRequestedAt: null,
    createdAt: 1_000,
    id: 'run-1',
    input: null,
    planPin,
    progression: {
      candidateVerdicts: [],
      commandReceipts: [],
      gateResolutions: [],
      nodes: [],
      occurrenceKey: 'occurrence-1',
      phase: 'uninitialized',
      schemaVersion: 1,
      terminal: null,
      values: [],
    },
    revision: 0,
    status: 'running',
    terminalAt: null,
    terminalFault: null,
    updatedAt: 1_000,
    ...overrides,
  });

export const nodeFixture = (overrides: Partial<RunNodeInstance> = {}): RunNodeInstance => {
  const runId = overrides.runId ?? 'run-1';
  const nodeKey = overrides.nodeKey ?? 'node';
  const forkScopeKey = overrides.forkScopeKey ?? deriveRootForkScopeKey(runId);
  const branchKey = overrides.branchKey ?? null;
  const iteration = overrides.iteration ?? 0;
  return createRunNodeInstance({
    activationContext: null,
    activationId: 'activation-1',
    activationKey: deriveActivationKey({ branchKey, forkScopeKey, iteration, nodeKey }),
    activeAttemptId: null,
    branchKey,
    createdAt: 1_000,
    forkScopeKey,
    id: 'node-1',
    iteration,
    nodeKey,
    parentActivationId: null,
    retryAvailableAt: null,
    revision: 0,
    runId,
    status: 'ready',
    terminalAt: null,
    terminalFault: null,
    updatedAt: 1_000,
    ...overrides,
  });
};

export const attemptFixture = (overrides: Partial<Attempt> = {}): Attempt => {
  const status: AttemptStatus = overrides.status ?? 'claimed';
  const started = status !== 'claimed' && status !== 'failed' && status !== 'cancelled';
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const unknown = status === 'unknown' || status === 'reconciling';
  return createAttempt({
    createdAt: 1_000,
    dispatchIdempotencyKey: 'dispatch-1',
    executorConfigurationDigest: configurationDigest,
    executorContractPin: executorPin,
    fault: unknown
      ? { code: 'UNKNOWN_OUTCOME', message: 'Outcome is unknown.' }
      : status === 'failed'
        ? { code: 'EXECUTOR_UNAVAILABLE', message: 'Execution failed.', retryable: false }
        : null,
    fencingToken: 1,
    id: 'attempt-1',
    lastHeartbeatAt: 1_000,
    leaseExpiresAt: 3_000,
    managerIncarnationId: 'manager-1',
    nodeInstanceId: 'node-1',
    ordinal: 0,
    ownerLabel: 'owner',
    progressionClosedAt: null,
    revision: 0,
    runId: 'run-1',
    startCommittedAt: started ? 1_000 : null,
    status,
    terminalAt: terminal ? 1_000 : null,
    updatedAt: 1_000,
    ...overrides,
  });
};

export const outputFixture = (overrides: Partial<RunOutput> = {}): RunOutput =>
  createRunOutput({
    correlation: { kind: 'run' },
    createdAt: 1_000,
    id: 'output-1',
    name: 'result',
    payload: { kind: 'json', value: null },
    runId: 'run-1',
    ...overrides,
  });

export const transitionFixture = (values: {
  readonly run: Run;
  readonly nodes?: readonly RunNodeInstance[];
  readonly attempts?: readonly Attempt[];
  readonly outputs?: readonly RunOutput[];
}): DomainTransition => ({
  attempts: values.attempts ?? [],
  changed: true,
  eventIntents: [],
  nodes: values.nodes ?? [],
  outputs: values.outputs ?? [],
  run: values.run,
});

export const claimTransitionFixture = (
  run: Run,
  node: RunNodeInstance,
  attempt: Attempt,
): DomainTransition =>
  applyDomainOperation({
    attempt,
    expectedNodeRevision: node.revision,
    expectedRunRevision: run.revision,
    kind: 'claim',
    node,
    run,
    transactionNow: attempt.createdAt,
  });

export const runExpectation = (run: Run): RunStoreRunExpectation => ({
  planPin: run.planPin,
  revision: run.revision,
  runId: run.id,
});

export const nodeExpectation = (node: RunNodeInstance): RunStoreNodeExpectation => ({
  activeAttemptId: node.activeAttemptId,
  nodeInstanceId: node.id,
  revision: node.revision,
});

export const attemptExpectation = (
  attempt: Attempt,
): RunStoreAttemptExpectation & {
  readonly handoff: {
    readonly kind: 'absent';
    readonly key: {
      readonly attemptId: string;
      readonly incumbentFencingToken: number;
    };
  };
} => ({
  attemptId: attempt.id,
  fencingToken: attempt.fencingToken,
  handoff: {
    key: {
      attemptId: attempt.id,
      incumbentFencingToken: attempt.fencingToken,
    },
    kind: 'absent',
  },
  leaseExpiresAt: attempt.leaseExpiresAt,
  managerIncarnationId: attempt.managerIncarnationId,
  revision: attempt.revision,
  status: attempt.status,
});

export const idempotency = (
  operation: RunStoreIdempotencyOperation,
  runId: string | null,
  subjectId: string | null,
  key: string = operation,
): RunStoreIdempotencyWrite => ({
  identity: { key, operation, runId, subjectId },
  request: { operation },
  result: { accepted: true },
});

export const executingNodeFixture = (
  status: Extract<RunNodeStatus, 'executing' | 'unknown'> = 'executing',
  overrides: Partial<RunNodeInstance> = {},
): RunNodeInstance =>
  nodeFixture({
    activeAttemptId: 'attempt-1',
    status,
    ...overrides,
  });
