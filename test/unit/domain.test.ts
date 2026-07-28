import { describe, expect, test } from 'vitest';

import {
  applyDomainOperation,
  createAttempt,
  createRun,
  createRunNodeInstance,
  createRunOutput,
  deriveActivationKey,
  deriveChildForkScopeKey,
  deriveRootForkScopeKey,
  isAttemptStatusTransitionAllowed,
  isRunNodeStatusTransitionAllowed,
  isRunStatusTransitionAllowed,
  validateRunAggregate,
  type Attempt,
  type AttemptStatus,
  type DomainOperation,
  type Run,
  type RunNodeInstance,
  type RunNodeStatus,
  type RunStatus,
} from '../../src/domain/index.js';

const runStatuses = [
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus[];

const runTargets: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  running: ['cancelling', 'succeeded', 'failed', 'cancelled'],
  cancelling: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const nodeStatuses = [
  'ready',
  'executing',
  'retry_waiting',
  'unknown',
  'gate_waiting',
  'join_waiting',
  'selector_waiting',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'retiring',
  'retired',
] as const satisfies readonly RunNodeStatus[];

const nodeTargets: Readonly<Record<RunNodeStatus, readonly RunNodeStatus[]>> = {
  ready: ['executing', 'cancelled', 'retired'],
  executing: [
    'succeeded',
    'failed',
    'retry_waiting',
    'unknown',
    'cancelled',
    'retiring',
    'retired',
  ],
  retry_waiting: ['executing', 'cancelled', 'retired'],
  unknown: ['executing', 'succeeded', 'failed', 'retry_waiting', 'cancelled', 'retiring'],
  gate_waiting: ['succeeded', 'cancelled', 'retired'],
  join_waiting: ['ready', 'succeeded', 'cancelled', 'retired'],
  selector_waiting: ['succeeded', 'cancelled', 'retired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
  retiring: ['retired'],
  retired: [],
};

const attemptStatuses = [
  'claimed',
  'start_committed',
  'unknown',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly AttemptStatus[];

const attemptTargets: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  claimed: ['start_committed', 'failed', 'cancelled'],
  start_committed: ['unknown', 'succeeded', 'failed', 'cancelled'],
  unknown: ['reconciling', 'succeeded', 'failed', 'cancelled'],
  reconciling: ['start_committed', 'unknown', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

describe('status transition tables', () => {
  test.each(runStatuses)('covers every Run transition from %s', (from) => {
    for (const to of runStatuses) {
      expect(isRunStatusTransitionAllowed(from, to)).toBe(runTargets[from].includes(to));
    }
  });

  test.each(nodeStatuses)('covers every node transition from %s', (from) => {
    for (const to of nodeStatuses) {
      expect(isRunNodeStatusTransitionAllowed(from, to)).toBe(nodeTargets[from].includes(to));
    }
  });

  test.each(attemptStatuses)('covers every Attempt transition from %s', (from) => {
    for (const to of attemptStatuses) {
      expect(isAttemptStatusTransitionAllowed(from, to)).toBe(attemptTargets[from].includes(to));
    }
  });
});

describe('activation coordinates', () => {
  test('uses deterministic versioned and domain-separated canonical tuples', () => {
    const root = deriveRootForkScopeKey('run-1');
    const child = deriveChildForkScopeKey(root, 'fork-activation-1');
    const activation = deriveActivationKey({
      branchKey: null,
      forkScopeKey: child,
      iteration: 0,
      nodeKey: 'node-a',
    });

    expect(root).toBe(deriveRootForkScopeKey('run-1'));
    expect(child).toBe(deriveChildForkScopeKey(root, 'fork-activation-1'));
    expect(activation).toBe(
      deriveActivationKey({
        branchKey: null,
        forkScopeKey: child,
        iteration: 0,
        nodeKey: 'node-a',
      }),
    );
    expect(root).not.toBe(child);
    expect(activation).not.toBe(child);
  });

  test('keeps explicit null and every activation coordinate significant', () => {
    const scope = deriveRootForkScopeKey('run-1');
    const base = {
      branchKey: null,
      forkScopeKey: scope,
      iteration: 0,
      nodeKey: 'node-a',
    } as const;

    expect(deriveActivationKey(base)).not.toBe(
      deriveActivationKey({ ...base, branchKey: 'branch-a' }),
    );
    expect(deriveActivationKey(base)).not.toBe(deriveActivationKey({ ...base, iteration: 1 }));
    expect(deriveActivationKey(base)).not.toBe(deriveActivationKey({ ...base, nodeKey: 'node-b' }));
    expect(() => deriveActivationKey({ ...base, iteration: -1 })).toThrow(RangeError);
  });

  test('keeps every child fork-scope coordinate significant', () => {
    const root = deriveRootForkScopeKey('run-1');

    expect(deriveChildForkScopeKey(root, 'fork-a')).not.toBe(
      deriveChildForkScopeKey(root, 'fork-b'),
    );
    expect(deriveChildForkScopeKey(root, 'fork-a')).not.toBe(
      deriveChildForkScopeKey(deriveRootForkScopeKey('run-2'), 'fork-a'),
    );
  });

  test.each([
    'sha256:abc',
    'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ] as const satisfies readonly `sha256:${string}`[])(
    'rejects malformed activation parent scope digest %s',
    (forkScopeKey) => {
      expect(() =>
        deriveActivationKey({
          branchKey: null,
          forkScopeKey,
          iteration: 0,
          nodeKey: 'node-a',
        }),
      ).toThrow(TypeError);
      expect(() => deriveChildForkScopeKey(forkScopeKey, 'fork-a')).toThrow(TypeError);
    },
  );
});

const runInput = {
  cancellationRequestedAt: null,
  createdAt: 100,
  id: 'run-1',
  input: { nested: ['value'] },
  metadata: { trace: 'trace-1' },
  planPin: { digest: 'plan-digest', id: 'plan-1', revision: 'revision-1' },
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
  updatedAt: 100,
};

const nodeInput = (
  status: RunNodeStatus,
  activeAttemptId: string | null = null,
): Record<string, unknown> => {
  const effectiveActiveAttemptId =
    status === 'retiring' && activeAttemptId === null ? 'attempt-1' : activeAttemptId;
  const terminal = ['succeeded', 'failed', 'cancelled', 'skipped', 'retired'].includes(status);
  return {
    activationContext: { input: ['value'] },
    activationId: 'activation-1',
    activationKey: deriveActivationKey({
      branchKey: null,
      forkScopeKey: deriveRootForkScopeKey('run-1'),
      iteration: 0,
      nodeKey: 'node-a',
    }),
    activeAttemptId: effectiveActiveAttemptId,
    branchKey: null,
    createdAt: 100,
    forkScopeKey: deriveRootForkScopeKey('run-1'),
    id: 'node-instance-1',
    iteration: 0,
    nodeKey: 'node-a',
    parentActivationId: null,
    retryAvailableAt: status === 'retry_waiting' ? 200 : null,
    revision: 0,
    runId: 'run-1',
    status,
    terminalAt: terminal ? 150 : null,
    terminalFault:
      status === 'failed' ? { code: 'INVALID_STATE', message: 'Known failure.' } : null,
    updatedAt: terminal ? 150 : 100,
  };
};

const attemptInput = (status: AttemptStatus): Record<string, unknown> => ({
  createdAt: 100,
  dispatchIdempotencyKey: 'dispatch-1',
  executorConfigurationDigest:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  executorContractPin: {
    adapterId: 'adapter-1',
    digest: 'executor-digest',
    revision: 'executor-revision',
  },
  fault:
    status === 'failed'
      ? { code: 'INVALID_STATE', message: 'Known failure.' }
      : status === 'unknown' || status === 'reconciling'
        ? { code: 'UNKNOWN_OUTCOME', message: 'Outcome is unknown.' }
        : null,
  fencingToken: 1,
  id: 'attempt-1',
  lastHeartbeatAt: 100,
  leaseExpiresAt: 200,
  managerIncarnationId: 'incarnation-1',
  nodeInstanceId: 'node-instance-1',
  ordinal: 0,
  ownerLabel: 'same-label',
  progressionClosedAt: null,
  revision: 0,
  runId: 'run-1',
  startCommittedAt: status === 'claimed' ? null : 110,
  status,
  terminalAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? 150 : null,
  updatedAt: ['succeeded', 'failed', 'cancelled'].includes(status)
    ? 150
    : status === 'claimed'
      ? 100
      : 110,
});

describe('immutable domain entities', () => {
  test('defensively snapshots and deeply freezes aggregate payloads', () => {
    const input = { nested: ['value'] };
    const run = createRun({ ...runInput, input });
    const node = createRunNodeInstance(nodeInput('ready'));

    input.nested[0] = 'mutated';

    expect(run.input).toEqual({ nested: ['value'] });
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.input)).toBe(true);
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.activationContext)).toBe(true);
  });

  test('rejects hostile descriptors, prototypes, getters, cycles, and invalid coordinates', () => {
    let getterReads = 0;
    const hostile = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return 'secret';
      },
    });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    expect(() => createRun({ ...runInput, input: hostile })).toThrow(TypeError);
    expect(getterReads).toBe(0);
    expect(() => createRun({ ...runInput, input: cycle })).toThrow(TypeError);
    expect(() =>
      createRunNodeInstance({ ...nodeInput('ready'), activationContext: new Date() }),
    ).toThrow(TypeError);
    expect(() => createRunNodeInstance({ ...nodeInput('ready'), iteration: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      createRunNodeInstance({
        ...nodeInput('ready'),
        activationKey: deriveActivationKey({
          branchKey: null,
          forkScopeKey: deriveRootForkScopeKey('run-1'),
          iteration: 1,
          nodeKey: 'node-a',
        }),
      }),
    ).toThrow(TypeError);
    expect(() =>
      createRunNodeInstance({
        ...nodeInput('ready'),
        forkScopeKey: 'sha256:not-a-canonical-digest',
      }),
    ).toThrow(TypeError);
  });

  test.each([
    [{ ...runInput, updatedAt: 99 }, 'Run'],
    [{ ...runInput, status: 'cancelling', cancellationRequestedAt: 151, updatedAt: 150 }, 'Run'],
    [{ ...runInput, status: 'succeeded', terminalAt: 151, updatedAt: 150 }, 'Run'],
  ] as const)('rejects invalid %s timestamp boundaries', (value, _entity) => {
    expect(() => createRun(value)).toThrow(TypeError);
  });

  test('rejects node and Attempt timestamps that move past updatedAt or collapse a lease', () => {
    expect(() =>
      createRunNodeInstance({ ...nodeInput('failed'), terminalAt: 151, updatedAt: 150 }),
    ).toThrow(TypeError);
    expect(() =>
      createRunNodeInstance({ ...nodeInput('retry_waiting'), retryAvailableAt: 99 }),
    ).toThrow(TypeError);
    expect(() =>
      createAttempt({ ...attemptInput('start_committed'), startCommittedAt: 111, updatedAt: 110 }),
    ).toThrow(TypeError);
    expect(() => createAttempt({ ...attemptInput('claimed'), leaseExpiresAt: 100 })).toThrow(
      TypeError,
    );
  });

  test('creates immutable repeated-name outputs without overwrite semantics', () => {
    const first = createRunOutput({
      correlation: { kind: 'run' },
      createdAt: 120,
      id: 'output-1',
      name: 'result',
      payload: { kind: 'json', value: { value: 1 } },
      runId: 'run-1',
    });
    const second = createRunOutput({
      correlation: { kind: 'run' },
      createdAt: 121,
      id: 'output-2',
      name: 'result',
      payload: { kind: 'json', value: { value: 2 } },
      runId: 'run-1',
    });

    expect(first.name).toBe(second.name);
    expect(first.id).not.toBe(second.id);
    expect(Object.isFrozen(first.payload)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test('enforces the closed correlation grammar without reading hostile payloads', () => {
    let reads = 0;
    const hostilePayload = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'secret';
      },
    });
    const base = {
      createdAt: 120,
      id: 'output-1',
      name: 'result',
      payload: { kind: 'json', value: hostilePayload },
      runId: 'run-1',
    };

    expect(() =>
      createRunOutput({
        ...base,
        correlation: {
          activationId: 'activation-1',
          attemptId: 'attempt-1',
          kind: 'node',
          nodeInstanceId: 'node-instance-1',
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createRunOutput({
        ...base,
        correlation: {
          attemptId: 'attempt-1',
          kind: 'attempt',
          nodeInstanceId: 'node-instance-1',
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createRunOutput({
        ...base,
        correlation: { kind: 'run' },
      }),
    ).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});

describe('active Attempt compatibility', () => {
  const activePairs = [
    ['executing', 'claimed'],
    ['executing', 'start_committed'],
    ['unknown', 'unknown'],
    ['unknown', 'reconciling'],
  ] as const satisfies readonly (readonly [RunNodeStatus, AttemptStatus])[];

  test.each(activePairs)('accepts %s with %s authority', (nodeStatus, attemptStatus) => {
    const run = createRun(runInput);
    const node = createRunNodeInstance(nodeInput(nodeStatus, 'attempt-1'));
    const attempt = createAttempt(attemptInput(attemptStatus));

    expect(() => validateRunAggregate({ attempts: [attempt], nodes: [node], run })).not.toThrow();
  });

  test.each(['start_committed', 'unknown', 'reconciling'] as const)(
    'accepts progression-closed %s authority only on a retiring node',
    (attemptStatus) => {
      const run = createRun(runInput);
      const node = createRunNodeInstance({
        ...nodeInput('retiring', 'attempt-1'),
        updatedAt: 120,
      });
      const attempt = createAttempt({
        ...attemptInput(attemptStatus),
        progressionClosedAt: 120,
        updatedAt: 120,
      });

      expect(() => validateRunAggregate({ attempts: [attempt], nodes: [node], run })).not.toThrow();
    },
  );

  test('rejects a progression close on claimed or before start-commit authority', () => {
    expect(() =>
      createAttempt({
        ...attemptInput('claimed'),
        progressionClosedAt: 100,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createAttempt({
        ...attemptInput('start_committed'),
        progressionClosedAt: 109,
      }),
    ).toThrow(TypeError);
  });

  test.each(
    nodeStatuses
      .flatMap((nodeStatus) =>
        attemptStatuses.map((attemptStatus) => [nodeStatus, attemptStatus] as const),
      )
      .filter(
        ([nodeStatus, attemptStatus]) =>
          !activePairs.some(
            ([validNode, validAttempt]) =>
              validNode === nodeStatus && validAttempt === attemptStatus,
          ),
      ),
  )('exhaustively rejects incompatible %s with %s', (nodeStatus, attemptStatus) => {
    const validate = (): void => {
      const run = createRun(runInput);
      const node = createRunNodeInstance(nodeInput(nodeStatus, 'attempt-1'));
      const attempt = createAttempt(attemptInput(attemptStatus));
      validateRunAggregate({ attempts: [attempt], nodes: [node], run });
    };

    expect(validate).toThrow(TypeError);
  });

  test.each(
    nodeStatuses.filter(
      (status) => status !== 'executing' && status !== 'unknown' && status !== 'retiring',
    ),
  )('requires no pointer for %s', (status) => {
    const run = createRun(runInput);
    const node = createRunNodeInstance(nodeInput(status));

    expect(() => validateRunAggregate({ attempts: [], nodes: [node], run })).not.toThrow();
  });

  test('validates terminal Run structure without selecting terminal policy', () => {
    const terminalRun: Run = createRun({
      ...runInput,
      progression: {
        ...runInput.progression,
        phase: 'terminal',
        terminal: { nodeKey: 'terminal', outcome: 'success' },
      },
      status: 'succeeded',
      terminalAt: 200,
      updatedAt: 200,
    });
    const terminalNode: RunNodeInstance = createRunNodeInstance(nodeInput('succeeded'));
    const historicalAttempt: Attempt = createAttempt(attemptInput('succeeded'));

    expect(() =>
      validateRunAggregate({
        attempts: [historicalAttempt],
        nodes: [terminalNode],
        run: terminalRun,
      }),
    ).not.toThrow();
    expect(() =>
      validateRunAggregate({
        attempts: [],
        nodes: [createRunNodeInstance(nodeInput('ready'))],
        run: terminalRun,
      }),
    ).toThrow(TypeError);
  });
});

const authority = (run: Run, node: RunNodeInstance, attempt: Attempt, transactionNow = 150) => ({
  attemptId: attempt.id,
  executorConfigurationDigest: attempt.executorConfigurationDigest,
  executorContractPin: attempt.executorContractPin,
  expectedAttemptRevision: attempt.revision,
  expectedNodeRevision: node.revision,
  expectedRunRevision: run.revision,
  fencingToken: attempt.fencingToken,
  managerIncarnationId: attempt.managerIncarnationId,
  transactionNow,
});

describe('combined Attempt operations and revisions', () => {
  test('claims, starts, records unknown, reconciles, and accepts a known result', () => {
    const run = createRun(runInput);
    const ready = createRunNodeInstance(nodeInput('ready'));
    const claimedAttempt = createAttempt({
      ...attemptInput('claimed'),
      createdAt: 150,
      lastHeartbeatAt: 150,
      updatedAt: 150,
    });
    const claim = applyDomainOperation({
      attempt: claimedAttempt,
      expectedNodeRevision: ready.revision,
      expectedRunRevision: run.revision,
      kind: 'claim',
      node: ready,
      run,
      transactionNow: 150,
    });

    expect(claim.run.revision).toBe(1);
    expect(claim.nodes[0]?.status).toBe('executing');
    expect(claim.nodes[0]?.revision).toBe(1);
    expect(claim.attempts[0]?.revision).toBe(0);
    expect(claim.eventIntents.map((event) => event.kind)).toEqual([
      'attempt.created',
      'node.transitioned',
    ]);

    const executing = claim.nodes[0];
    const claimed = claim.attempts[0];
    expect(executing).toBeDefined();
    expect(claimed).toBeDefined();
    if (!executing || !claimed) return;

    const start = applyDomainOperation({
      authority: authority(claim.run, executing, claimed),
      attempt: claimed,
      kind: 'start',
      node: executing,
      run: claim.run,
    });
    expect(start.run).toStrictEqual(claim.run);
    expect(start.nodes[0]).toStrictEqual(executing);
    expect(start.attempts[0]?.status).toBe('start_committed');
    expect(start.attempts[0]?.revision).toBe(1);

    const started = start.attempts[0];
    if (!started) return;
    const unknown = applyDomainOperation({
      attempt: started,
      authority: authority(start.run, executing, started),
      fault: { code: 'UNKNOWN_OUTCOME', message: 'Outcome is unknown.' },
      kind: 'direct_unknown',
      node: executing,
      run: start.run,
    });
    expect(unknown.run.revision).toBe(2);
    expect(unknown.nodes[0]?.status).toBe('unknown');
    expect(unknown.attempts[0]?.status).toBe('unknown');

    const unknownNode = unknown.nodes[0];
    const unknownAttempt = unknown.attempts[0];
    if (!unknownNode || !unknownAttempt) return;
    const reconciling = applyDomainOperation({
      attempt: unknownAttempt,
      authority: authority(unknown.run, unknownNode, unknownAttempt),
      kind: 'begin_reconciliation',
      node: unknownNode,
      run: unknown.run,
    });
    expect(reconciling.run).toStrictEqual(unknown.run);
    expect(reconciling.nodes[0]).toStrictEqual(unknownNode);
    expect(reconciling.attempts[0]?.status).toBe('reconciling');
    expect(reconciling.attempts[0]?.revision).toBe(unknownAttempt.revision + 1);

    const reconcilingAttempt = reconciling.attempts[0];
    if (!reconcilingAttempt) return;
    const succeeded = applyDomainOperation({
      attempt: reconcilingAttempt,
      authority: authority(reconciling.run, unknownNode, reconcilingAttempt),
      kind: 'reconciled_success',
      node: unknownNode,
      outputs: [
        createRunOutput({
          correlation: {
            activationId: unknownNode.activationId,
            attemptId: reconcilingAttempt.id,
            kind: 'attempt',
            nodeInstanceId: unknownNode.id,
          },
          createdAt: 150,
          id: 'output-success',
          name: 'result',
          payload: { kind: 'json', value: { ok: true } },
          runId: run.id,
        }),
      ],
      run: reconciling.run,
    });

    expect(succeeded.run.revision).toBe(reconciling.run.revision + 1);
    expect(succeeded.nodes[0]?.status).toBe('succeeded');
    expect(succeeded.nodes[0]?.activeAttemptId).toBeNull();
    expect(succeeded.attempts[0]?.status).toBe('succeeded');
    expect(succeeded.eventIntents.map((event) => event.kind)).toEqual([
      'attempt.transitioned',
      'output.recorded',
      'node.transitioned',
    ]);
  });

  test('rejects stale identity, fence, revision, pin, and lease equality without mutation', () => {
    const run = createRun({ ...runInput, revision: 4 });
    const node = createRunNodeInstance({
      ...nodeInput('executing', 'attempt-1'),
      revision: 5,
    });
    const attempt = createAttempt({
      ...attemptInput('start_committed'),
      revision: 6,
    });
    const validAuthority = authority(run, node, attempt, attempt.leaseExpiresAt);
    const variants = [
      validAuthority,
      { ...validAuthority, attemptId: 'other-attempt' },
      { ...validAuthority, expectedRunRevision: 3 },
      { ...validAuthority, expectedNodeRevision: 4 },
      { ...validAuthority, expectedAttemptRevision: 5 },
      { ...validAuthority, managerIncarnationId: 'other-incarnation' },
      { ...validAuthority, fencingToken: 2 },
      {
        ...validAuthority,
        executorConfigurationDigest:
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      {
        ...validAuthority,
        executorContractPin: { ...attempt.executorContractPin, revision: 'other' },
      },
    ] as const;

    for (const rejectedAuthority of variants) {
      expect(() =>
        applyDomainOperation({
          attempt,
          authority: rejectedAuthority,
          kind: 'direct_success',
          node,
          outputs: [],
          run,
        }),
      ).toThrow(TypeError);
      expect(run.revision).toBe(4);
      expect(node.revision).toBe(5);
      expect(attempt.revision).toBe(6);
      expect(node.activeAttemptId).toBe(attempt.id);
    }
  });

  test('does not let a diagnostic owner label confer authority', () => {
    const run = createRun(runInput);
    const node = createRunNodeInstance(nodeInput('executing', 'attempt-1'));
    const attempt = createAttempt(attemptInput('start_committed'));
    const sameLabelDifferentAuthority = {
      ...authority(run, node, attempt),
      managerIncarnationId: 'different-incarnation',
    };

    expect(attempt.ownerLabel).toBe('same-label');
    expect(() =>
      applyDomainOperation({
        attempt,
        authority: sameLabelDifferentAuthority,
        kind: 'direct_success',
        node,
        outputs: [],
        run,
      }),
    ).toThrow(TypeError);
  });

  test('rejects revision overflow before creating any intent', () => {
    const run = createRun({ ...runInput, revision: Number.MAX_SAFE_INTEGER });
    const node = createRunNodeInstance(nodeInput('ready'));
    const attempt = createAttempt({
      ...attemptInput('claimed'),
      createdAt: 150,
      lastHeartbeatAt: 150,
      updatedAt: 150,
    });

    expect(() =>
      applyDomainOperation({
        attempt,
        expectedNodeRevision: node.revision,
        expectedRunRevision: run.revision,
        kind: 'claim',
        node,
        run,
        transactionNow: 150,
      }),
    ).toThrow(RangeError);
  });
});

type ResultKind =
  | 'pre_start_failure'
  | 'pre_start_cancellation'
  | 'direct_success'
  | 'direct_failure'
  | 'direct_cancellation'
  | 'direct_unknown'
  | 'begin_reconciliation'
  | 'late_success'
  | 'late_failure'
  | 'late_cancellation'
  | 'reconciled_running'
  | 'reconciled_unknown'
  | 'reconciled_success'
  | 'reconciled_failure'
  | 'reconciled_cancellation';

const resultKinds = [
  'pre_start_failure',
  'pre_start_cancellation',
  'direct_success',
  'direct_failure',
  'direct_cancellation',
  'direct_unknown',
  'begin_reconciliation',
  'late_success',
  'late_failure',
  'late_cancellation',
  'reconciled_running',
  'reconciled_unknown',
  'reconciled_success',
  'reconciled_failure',
  'reconciled_cancellation',
] as const satisfies readonly ResultKind[];

const resultOperation = (
  kind: ResultKind,
  run: Run,
  node: RunNodeInstance,
  attempt: Attempt,
): DomainOperation => {
  const shared = { attempt, authority: authority(run, node, attempt), node, run };
  switch (kind) {
    case 'pre_start_failure':
    case 'direct_failure':
    case 'late_failure':
    case 'reconciled_failure':
      return {
        ...shared,
        fault: { code: 'INVALID_STATE', message: 'Known failure.' },
        kind,
        retryAvailableAt: null,
      };
    case 'direct_success':
    case 'late_success':
    case 'reconciled_success':
      return { ...shared, kind, outputs: [] };
    case 'direct_unknown':
      return {
        ...shared,
        fault: { code: 'UNKNOWN_OUTCOME', message: 'Outcome is unknown.' },
        kind,
      };
    case 'pre_start_cancellation':
    case 'direct_cancellation':
    case 'begin_reconciliation':
    case 'late_cancellation':
    case 'reconciled_running':
    case 'reconciled_unknown':
    case 'reconciled_cancellation':
      return { ...shared, kind };
  }
  throw new TypeError('Result operation kind is invalid.');
};

const activePair = (
  nodeStatus: 'executing' | 'unknown',
  attemptStatus: 'claimed' | 'start_committed' | 'unknown' | 'reconciling',
): { readonly run: Run; readonly node: RunNodeInstance; readonly attempt: Attempt } => {
  const run = createRun(runInput);
  const node = createRunNodeInstance(nodeInput(nodeStatus, 'attempt-1'));
  const attempt = createAttempt(attemptInput(attemptStatus));
  return { attempt, node, run };
};

describe('exact combined operation matrix', () => {
  test('accepts exactly the authoritative cells across the complete source/state/fence matrix', () => {
    const expectedPairs: Readonly<Record<ResultKind, readonly [RunNodeStatus, AttemptStatus]>> = {
      begin_reconciliation: ['unknown', 'unknown'],
      direct_cancellation: ['executing', 'start_committed'],
      direct_failure: ['executing', 'start_committed'],
      direct_success: ['executing', 'start_committed'],
      direct_unknown: ['executing', 'start_committed'],
      late_cancellation: ['unknown', 'unknown'],
      late_failure: ['unknown', 'unknown'],
      late_success: ['unknown', 'unknown'],
      pre_start_cancellation: ['executing', 'claimed'],
      pre_start_failure: ['executing', 'claimed'],
      reconciled_cancellation: ['unknown', 'reconciling'],
      reconciled_failure: ['unknown', 'reconciling'],
      reconciled_running: ['unknown', 'reconciling'],
      reconciled_success: ['unknown', 'reconciling'],
      reconciled_unknown: ['unknown', 'reconciling'],
    };
    const pointerVariants = ['absent', 'wrong', 'matching'] as const;
    const timeVariants = [150, 200, 201] as const;
    let accepted = 0;

    for (const kind of resultKinds) {
      for (const nodeStatus of nodeStatuses) {
        for (const attemptStatus of attemptStatuses) {
          const attempt = createAttempt(attemptInput(attemptStatus));
          for (const pointerVariant of pointerVariants) {
            const pointer =
              pointerVariant === 'matching'
                ? attempt.id
                : pointerVariant === 'wrong'
                  ? 'other-attempt'
                  : null;
            const validPointer =
              nodeStatus === 'executing' || nodeStatus === 'unknown' ? attempt.id : null;
            const validNode = createRunNodeInstance(nodeInput(nodeStatus, validPointer));
            const node = Object.freeze({ ...validNode, activeAttemptId: pointer });
            const run = createRun(runInput);
            const before = JSON.stringify([run, node, attempt]);
            for (const revisionsMatch of [false, true]) {
              for (const incarnationMatches of [false, true]) {
                for (const fenceMatches of [false, true]) {
                  for (const transactionNow of timeVariants) {
                    const base = resultOperation(kind, run, node, attempt);
                    if (!('authority' in base)) throw new TypeError('Authority is required.');
                    const operation = {
                      ...base,
                      authority: {
                        ...base.authority,
                        expectedRunRevision: revisionsMatch
                          ? base.authority.expectedRunRevision
                          : base.authority.expectedRunRevision + 1,
                        fencingToken: fenceMatches
                          ? base.authority.fencingToken
                          : base.authority.fencingToken + 1,
                        managerIncarnationId: incarnationMatches
                          ? base.authority.managerIncarnationId
                          : 'other-incarnation',
                        transactionNow,
                      },
                    };
                    const expectedPair = expectedPairs[kind];
                    const shouldAccept =
                      expectedPair[0] === nodeStatus &&
                      expectedPair[1] === attemptStatus &&
                      pointerVariant === 'matching' &&
                      revisionsMatch &&
                      incarnationMatches &&
                      fenceMatches &&
                      transactionNow < attempt.leaseExpiresAt;
                    let rejected = false;
                    try {
                      applyDomainOperation(operation);
                      accepted += 1;
                    } catch (error) {
                      rejected = true;
                      if (shouldAccept) throw error;
                      if (JSON.stringify([run, node, attempt]) !== before) {
                        throw new Error('Rejected operation mutated its input.', { cause: error });
                      }
                    }
                    if (!shouldAccept && !rejected) {
                      throw new Error(
                        `Unexpected acceptance: ${kind}/${nodeStatus}/${attemptStatus}`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(accepted).toBe(resultKinds.length);
  }, 180_000);

  test.each([
    ['pre_start_failure', 'executing', 'claimed', 'failed', 'failed', 1, 1, 1],
    ['pre_start_cancellation', 'executing', 'claimed', 'cancelled', 'cancelled', 1, 1, 1],
    ['direct_success', 'executing', 'start_committed', 'succeeded', 'succeeded', 1, 1, 1],
    ['direct_failure', 'executing', 'start_committed', 'failed', 'failed', 1, 1, 1],
    ['direct_cancellation', 'executing', 'start_committed', 'cancelled', 'cancelled', 1, 1, 1],
    ['direct_unknown', 'executing', 'start_committed', 'unknown', 'unknown', 1, 1, 1],
    ['begin_reconciliation', 'unknown', 'unknown', 'unknown', 'reconciling', 0, 0, 1],
    ['late_success', 'unknown', 'unknown', 'succeeded', 'succeeded', 1, 1, 1],
    ['late_failure', 'unknown', 'unknown', 'failed', 'failed', 1, 1, 1],
    ['late_cancellation', 'unknown', 'unknown', 'cancelled', 'cancelled', 1, 1, 1],
    ['reconciled_running', 'unknown', 'reconciling', 'executing', 'start_committed', 1, 1, 1],
    ['reconciled_unknown', 'unknown', 'reconciling', 'unknown', 'unknown', 0, 0, 1],
    ['reconciled_success', 'unknown', 'reconciling', 'succeeded', 'succeeded', 1, 1, 1],
    ['reconciled_failure', 'unknown', 'reconciling', 'failed', 'failed', 1, 1, 1],
    ['reconciled_cancellation', 'unknown', 'reconciling', 'cancelled', 'cancelled', 1, 1, 1],
  ] as const)(
    '%s accepts only %s + %s and applies exact revisions',
    (
      kind,
      nodeStatus,
      attemptStatus,
      expectedNodeStatus,
      expectedAttemptStatus,
      runDelta,
      nodeDelta,
      attemptDelta,
    ) => {
      const current = activePair(nodeStatus, attemptStatus);
      const result = applyDomainOperation(
        resultOperation(kind, current.run, current.node, current.attempt),
      );

      expect(result.run.revision).toBe(current.run.revision + runDelta);
      expect(result.nodes[0]?.revision).toBe(current.node.revision + nodeDelta);
      expect(result.attempts[0]?.revision).toBe(current.attempt.revision + attemptDelta);
      expect(result.nodes[0]?.status).toBe(expectedNodeStatus);
      expect(result.attempts[0]?.status).toBe(expectedAttemptStatus);
    },
  );

  test.each([
    ['direct_success', 'executing', 'claimed'],
    ['direct_unknown', 'executing', 'claimed'],
    ['late_success', 'executing', 'claimed'],
    ['reconciled_success', 'executing', 'claimed'],
    ['direct_success', 'unknown', 'unknown'],
    ['direct_success', 'unknown', 'reconciling'],
    ['late_success', 'executing', 'start_committed'],
    ['late_success', 'unknown', 'reconciling'],
    ['reconciled_success', 'executing', 'start_committed'],
    ['reconciled_success', 'unknown', 'unknown'],
    ['pre_start_failure', 'executing', 'start_committed'],
    ['pre_start_failure', 'unknown', 'unknown'],
    ['pre_start_failure', 'unknown', 'reconciling'],
    ['pre_start_cancellation', 'executing', 'start_committed'],
  ] as const)('%s rejects incompatible %s + %s', (kind, nodeStatus, attemptStatus) => {
    const current = activePair(nodeStatus, attemptStatus);

    expect(() =>
      applyDomainOperation(resultOperation(kind, current.run, current.node, current.attempt)),
    ).toThrow(TypeError);
    expect(current.run.revision).toBe(0);
    expect(current.node.revision).toBe(0);
    expect(current.attempt.revision).toBe(0);
  });

  test.each([
    ['direct_failure', 'executing', 'start_committed'],
    ['late_failure', 'unknown', 'unknown'],
    ['reconciled_failure', 'unknown', 'reconciling'],
  ] as const)(
    '%s accepts an already supplied retry decision',
    (kind, nodeStatus, attemptStatus) => {
      const current = activePair(nodeStatus, attemptStatus);
      const base = resultOperation(kind, current.run, current.node, current.attempt);
      if (
        base.kind !== 'direct_failure' &&
        base.kind !== 'late_failure' &&
        base.kind !== 'reconciled_failure'
      ) {
        return;
      }
      const result = applyDomainOperation({ ...base, retryAvailableAt: 175 });

      expect(result.nodes[0]?.status).toBe('retry_waiting');
      expect(result.nodes[0]?.retryAvailableAt).toBe(175);
      expect(result.nodes[0]?.activeAttemptId).toBeNull();
      expect(result.attempts[0]?.status).toBe('failed');
    },
  );

  test('rejects every result replay after authority was cleared without mutating inputs', () => {
    const current = activePair('unknown', 'unknown');
    const first = applyDomainOperation(
      resultOperation('late_success', current.run, current.node, current.attempt),
    );
    const terminalNode = first.nodes[0];
    const terminalAttempt = first.attempts[0];
    if (!terminalNode || !terminalAttempt) return;

    const before = JSON.stringify([first.run, terminalNode, terminalAttempt]);
    expect(() =>
      applyDomainOperation(
        resultOperation('late_success', first.run, terminalNode, terminalAttempt),
      ),
    ).toThrow('STALE_FENCE');
    expect(JSON.stringify([first.run, terminalNode, terminalAttempt])).toBe(before);
  });

  test('does not turn an unknown outcome into retry authority', async () => {
    const current = activePair('unknown', 'unknown');
    const source = await import('../../src/domain/index.js');

    expect(Object.keys(source)).not.toContain('retryUnknownAttempt');
    expect(current.node.activeAttemptId).toBe(current.attempt.id);
    expect(current.attempt.status).toBe('unknown');
  });
});

describe('remaining revision rows and prospective-only operations', () => {
  test('renews a lease as an Attempt-only supplied DB-time change', () => {
    const current = activePair('executing', 'start_committed');
    const result = applyDomainOperation({
      attempt: current.attempt,
      authority: authority(current.run, current.node, current.attempt),
      kind: 'renew_lease',
      nextLastHeartbeatAt: 150,
      nextLeaseExpiresAt: 250,
      node: current.node,
      run: current.run,
    });

    expect(result.run).toStrictEqual(current.run);
    expect(result.nodes[0]).toStrictEqual(current.node);
    expect(result.attempts[0]?.revision).toBe(current.attempt.revision + 1);
    expect(result.attempts[0]?.lastHeartbeatAt).toBe(150);
    expect(result.attempts[0]?.leaseExpiresAt).toBe(250);
    expect(result.eventIntents).toEqual([]);
  });

  test.each([
    ['executing', 'claimed'],
    ['executing', 'start_committed'],
    ['unknown', 'unknown'],
    ['unknown', 'reconciling'],
  ] as const)('renews only the active compatible %s + %s pair', (nodeStatus, attemptStatus) => {
    const current = activePair(nodeStatus, attemptStatus);
    expect(() =>
      applyDomainOperation({
        attempt: current.attempt,
        authority: authority(current.run, current.node, current.attempt),
        kind: 'renew_lease',
        nextLastHeartbeatAt: 150,
        nextLeaseExpiresAt: 250,
        node: current.node,
        run: current.run,
      }),
    ).not.toThrow();
  });

  test('rejects lease renewal at expiry and after terminal pointer clearing', () => {
    const current = activePair('executing', 'start_committed');
    const atExpiry = {
      ...authority(current.run, current.node, current.attempt),
      transactionNow: current.attempt.leaseExpiresAt,
    };
    expect(() =>
      applyDomainOperation({
        attempt: current.attempt,
        authority: atExpiry,
        kind: 'renew_lease',
        nextLastHeartbeatAt: atExpiry.transactionNow,
        nextLeaseExpiresAt: atExpiry.transactionNow + 100,
        node: current.node,
        run: current.run,
      }),
    ).toThrow('STALE_FENCE');

    const terminal = applyDomainOperation(
      resultOperation('direct_success', current.run, current.node, current.attempt),
    );
    const node = terminal.nodes[0];
    const attempt = terminal.attempts[0];
    if (!node || !attempt) return;
    expect(() =>
      applyDomainOperation({
        attempt,
        authority: authority(terminal.run, node, attempt),
        kind: 'renew_lease',
        nextLastHeartbeatAt: 160,
        nextLeaseExpiresAt: 260,
        node,
        run: terminal.run,
      }),
    ).toThrow('STALE_FENCE');
  });

  test('activates multiple nodes with one Run revision and revision-zero new nodes', () => {
    const run = createRun(runInput);
    const first = createRunNodeInstance(nodeInput('ready'));
    const second = createRunNodeInstance({
      ...nodeInput('gate_waiting'),
      activationId: 'activation-2',
      activationKey: deriveActivationKey({
        branchKey: 'branch-b',
        forkScopeKey: deriveRootForkScopeKey('run-1'),
        iteration: 0,
        nodeKey: 'node-b',
      }),
      branchKey: 'branch-b',
      id: 'node-instance-2',
      nodeKey: 'node-b',
    });
    const result = applyDomainOperation({
      kind: 'activate_nodes',
      nodes: [first, second],
      run,
      transactionNow: 100,
    });

    expect(result.run.revision).toBe(1);
    expect(result.nodes.map((node) => node.revision)).toEqual([0, 0]);
    expect(result.eventIntents.map((event) => event.kind)).toEqual([
      'node.activated',
      'node.activated',
    ]);
  });

  test('cancels non-active nodes in stable event order with one Run delta', () => {
    const run = createRun(runInput);
    const first = createRunNodeInstance({
      ...nodeInput('ready'),
      activationKey: deriveActivationKey({
        branchKey: null,
        forkScopeKey: deriveRootForkScopeKey('run-1'),
        iteration: 0,
        nodeKey: 'node-z',
      }),
      activationId: 'activation-z',
      id: 'node-z',
      nodeKey: 'node-z',
    });
    const second = createRunNodeInstance({
      ...nodeInput('join_waiting'),
      activationId: 'activation-a',
      activationKey: deriveActivationKey({
        branchKey: null,
        forkScopeKey: deriveRootForkScopeKey('run-1'),
        iteration: 0,
        nodeKey: 'node-b',
      }),
      id: 'node-a',
      nodeKey: 'node-b',
    });
    const active = activePair('executing', 'start_committed');
    const result = applyDomainOperation({
      attempts: [active.attempt],
      kind: 'request_cancellation',
      nodes: [first, active.node, second],
      run,
      transactionNow: 150,
    });

    expect(result.run.status).toBe('cancelling');
    expect(result.run.revision).toBe(1);
    expect(result.nodes.map((node) => node.revision)).toEqual([1, 0, 1]);
    expect(result.nodes[1]).toStrictEqual(active.node);
    expect(result.attempts[0]).toStrictEqual(active.attempt);
    expect(
      result.eventIntents
        .slice(1)
        .map((event) =>
          event.correlation.kind === 'node' ? event.correlation.nodeInstanceId : '',
        ),
    ).toEqual(['node-a', 'node-z']);

    const replay = applyDomainOperation({
      attempts: result.attempts,
      kind: 'request_cancellation',
      nodes: result.nodes,
      run: result.run,
      transactionNow: 151,
    });
    expect(replay.changed).toBe(false);
    expect(replay.run).toStrictEqual(result.run);
    expect(replay.nodes).toEqual(result.nodes);
    expect(replay.attempts).toEqual(result.attempts);
    expect(replay.eventIntents).toEqual([]);
  });

  test('validates the complete cancellation aggregate before a cancelling no-op', () => {
    const active = activePair('executing', 'start_committed');
    const cancellingRun = createRun({
      ...runInput,
      cancellationRequestedAt: 150,
      status: 'cancelling',
      updatedAt: 150,
    });
    const foreignNode = createRunNodeInstance({
      ...nodeInput('ready'),
      id: 'foreign-node',
      runId: 'foreign-run',
    });

    expect(() =>
      applyDomainOperation({
        attempts: [active.attempt],
        kind: 'request_cancellation',
        nodes: [active.node, active.node],
        run: cancellingRun,
        transactionNow: 151,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyDomainOperation({
        attempts: [active.attempt],
        kind: 'request_cancellation',
        nodes: [active.node, foreignNode],
        run: cancellingRun,
        transactionNow: 151,
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyDomainOperation({
        attempts: [],
        kind: 'request_cancellation',
        nodes: [active.node],
        run: cancellingRun,
        transactionNow: 151,
      }),
    ).toThrow(TypeError);
  });

  test('reconstructs a claimed Attempt before accepting it', () => {
    const run = createRun(runInput);
    const node = createRunNodeInstance(nodeInput('ready'));
    const valid = createAttempt({
      ...attemptInput('claimed'),
      createdAt: 150,
      lastHeartbeatAt: 150,
      updatedAt: 150,
    });
    const forged = { ...valid, leaseExpiresAt: valid.lastHeartbeatAt };

    expect(() =>
      applyDomainOperation({
        attempt: forged,
        expectedNodeRevision: node.revision,
        expectedRunRevision: run.revision,
        kind: 'claim',
        node,
        run,
        transactionNow: 150,
      }),
    ).toThrow(TypeError);
  });

  test('answers a gate and progresses a join without selecting graph policy', () => {
    const run = createRun(runInput);
    const gate = createRunNodeInstance(nodeInput('gate_waiting'));
    const answer = createRunOutput({
      correlation: {
        activationId: gate.activationId,
        kind: 'node',
        nodeInstanceId: gate.id,
      },
      createdAt: 150,
      id: 'answer-1',
      name: 'answer',
      payload: { kind: 'json', value: { resolution: 'approved' } },
      runId: run.id,
    });
    const answered = applyDomainOperation({
      expectedNodeRevision: gate.revision,
      expectedRunRevision: run.revision,
      kind: 'gate_answer',
      node: gate,
      output: answer,
      run,
      transactionNow: 150,
    });

    expect(answered.run.revision).toBe(1);
    expect(answered.nodes[0]?.status).toBe('succeeded');
    expect(answered.outputs).toEqual([answer]);
    expect(answered.eventIntents).toEqual([]);

    const join = createRunNodeInstance({
      ...nodeInput('join_waiting'),
      activationId: 'join-activation',
      id: 'join-node',
    });
    const joined = applyDomainOperation({
      expectedNodeRevision: join.revision,
      expectedRunRevision: run.revision,
      kind: 'join_ready',
      node: join,
      run,
      transactionNow: 150,
    });
    expect(joined.nodes[0]?.status).toBe('ready');
    expect(joined.eventIntents).toEqual([]);
  });
});

describe('event-intent and package-private surface', () => {
  test('emits closed immutable intents without durable sequence or creation time', () => {
    const current = activePair('executing', 'start_committed');
    const result = applyDomainOperation(
      resultOperation('direct_success', current.run, current.node, current.attempt),
    );

    expect(result.eventIntents).not.toHaveLength(0);
    for (const intent of result.eventIntents) {
      expect(Object.isFrozen(intent)).toBe(true);
      expect(Object.isFrozen(intent.correlation)).toBe(true);
      expect(Object.isFrozen(intent.payload)).toBe(true);
      expect(intent).not.toHaveProperty('sequence');
      expect(intent).not.toHaveProperty('createdAt');
      expect(Object.keys(intent).sort()).toEqual(['correlation', 'kind', 'payload', 'runId']);
    }
  });

  test('keeps reducers and speculative boundaries out of the package root', async () => {
    const rootSource = await import('../../src/index.js');
    const domainEntry = await import('../../src/domain/index.js');

    expect(Object.keys(rootSource)).toEqual([]);
    expect(Object.keys(domainEntry).sort()).toEqual([
      'applyDomainOperation',
      'applyRunProgression',
      'createAttempt',
      'createRun',
      'createRunNodeInstance',
      'createRunOutput',
      'deriveActivationKey',
      'deriveChildForkScopeKey',
      'deriveRootForkScopeKey',
      'isAttemptStatusTransitionAllowed',
      'isRunNodeStatusTransitionAllowed',
      'isRunStatusTransitionAllowed',
      'validateRunAggregate',
    ]);
    for (const forbidden of [
      'Gate',
      'JoinArrival',
      'handoff',
      'takeover',
      'terminalSelector',
      'createRunManager',
      'RunManager',
    ]) {
      expect(Object.keys(domainEntry)).not.toContain(forbidden);
    }
  });
});
