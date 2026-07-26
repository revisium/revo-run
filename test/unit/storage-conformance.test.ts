import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AttemptHandoffState,
  RunStoreAcquireAttemptCommand,
  RunStoreClaimAttemptCommand,
  RunStoreCommitCommand,
  RunStoreCreateRunCommand,
  RunStoreIncumbentAuthority,
  RunStoreIncumbentTransitionCommand,
  RunStoreNonRenewIncumbentTransitionCommand,
  RunStoreRenewLeaseTransitionCommand,
  RunStoreUnownedOperation,
  RunStoreUnownedTransitionCommand,
  RunStoreWriteHandoffCommand,
} from '../../src/storage/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  attemptExpectation,
  attemptFixture,
  claimTransitionFixture,
  configurationDigest,
  executingNodeFixture,
  executorPin,
  idempotency,
  nodeExpectation,
  nodeFixture,
  outputFixture,
  runExpectation,
  runFixture,
  transitionFixture,
} from '../support/store-fixtures.js';

const createCommand = (runId = 'run-1', key = 'start'): RunStoreCreateRunCommand => {
  const run = runFixture({ id: runId });
  const node = nodeFixture({ id: `${runId}-node`, runId });
  const output = outputFixture({ id: `${runId}-output`, runId });
  return {
    eventIntents: [
      {
        correlation: {
          activationId: node.activationId,
          kind: 'node',
          nodeInstanceId: node.id,
        },
        kind: 'node.activated',
        payload: {
          activationKey: node.activationKey,
          branchKey: node.branchKey,
          forkScopeKey: node.forkScopeKey,
          iteration: node.iteration,
          nodeKey: node.nodeKey,
          status: 'ready',
        },
        runId,
      },
    ],
    expected: {
      absentNodes: [
        {
          activationId: node.activationId,
          activationKey: node.activationKey,
          forkScopeKey: node.forkScopeKey,
          nodeInstanceId: node.id,
          runId,
        },
      ],
      absentOutputIds: [output.id],
      absentRunId: runId,
    },
    idempotency: idempotency('start_run', null, null, key),
    kind: 'create_run',
    nodes: [node],
    outputs: [output],
    run,
  };
};

const authority = (
  runRevision: number,
  nodeRevision: number,
  attemptRevision: number,
): RunStoreIncumbentAuthority => ({
  attemptId: 'attempt-1',
  executorConfigurationDigest: configurationDigest,
  executorContractPin: executorPin,
  expectedAttemptRevision: attemptRevision,
  expectedNodeRevision: nodeRevision,
  expectedRunRevision: runRevision,
  fencingToken: 1,
  managerIncarnationId: 'manager-1',
});

const incumbentCase = (
  operation: RunStoreNonRenewIncumbentTransitionCommand['operation'],
): {
  readonly attempt: ReturnType<typeof attemptFixture>;
  readonly command: RunStoreNonRenewIncumbentTransitionCommand;
  readonly node: ReturnType<typeof executingNodeFixture>;
  readonly run: ReturnType<typeof runFixture>;
} => {
  const sourceStatus =
    operation === 'start' ||
    operation === 'pre_start_failure' ||
    operation === 'pre_start_cancellation'
      ? 'claimed'
      : operation.startsWith('direct_')
        ? 'start_committed'
        : operation.startsWith('late_')
          ? 'unknown'
          : operation === 'begin_reconciliation'
            ? 'unknown'
            : 'reconciling';
  const sourceNodeStatus =
    sourceStatus === 'unknown' || sourceStatus === 'reconciling' ? 'unknown' : 'executing';
  const run = runFixture();
  const node = executingNodeFixture(sourceNodeStatus, { revision: 1 });
  const attempt = attemptFixture({ status: sourceStatus });
  const resultStatus =
    operation === 'start' || operation === 'reconciled_running'
      ? 'start_committed'
      : operation === 'begin_reconciliation'
        ? 'reconciling'
        : operation.endsWith('_unknown')
          ? 'unknown'
          : operation.endsWith('_success')
            ? 'succeeded'
            : operation.endsWith('_cancellation')
              ? 'cancelled'
              : 'failed';
  const attemptOnly =
    operation === 'start' ||
    operation === 'begin_reconciliation' ||
    operation === 'reconciled_unknown';
  const nextNodeStatus =
    resultStatus === 'start_committed'
      ? 'executing'
      : resultStatus === 'reconciling' || resultStatus === 'unknown'
        ? 'unknown'
        : resultStatus;
  const nextRun = runFixture({
    revision: attemptOnly ? 0 : 1,
    updatedAt: attemptOnly ? 1_000 : 1_500,
  });
  const nextNode = attemptOnly
    ? node
    : nodeFixture({
        activeAttemptId:
          nextNodeStatus === 'executing' || nextNodeStatus === 'unknown' ? attempt.id : null,
        id: node.id,
        revision: 2,
        runId: run.id,
        status: nextNodeStatus,
        terminalAt:
          nextNodeStatus === 'succeeded' ||
          nextNodeStatus === 'failed' ||
          nextNodeStatus === 'cancelled'
            ? 1_500
            : null,
        terminalFault:
          nextNodeStatus === 'failed'
            ? { code: 'EXECUTOR_UNAVAILABLE', message: 'Execution failed.' }
            : nextNodeStatus === 'unknown'
              ? null
              : null,
        updatedAt: 1_500,
      });
  const startedBefore = sourceStatus !== 'claimed';
  const nextAttempt = attemptFixture({
    fault:
      resultStatus === 'unknown' || resultStatus === 'reconciling'
        ? { code: 'UNKNOWN_OUTCOME', message: 'Outcome is unknown.' }
        : resultStatus === 'failed'
          ? { code: 'EXECUTOR_UNAVAILABLE', message: 'Execution failed.' }
          : null,
    revision: 1,
    startCommittedAt: resultStatus === 'start_committed' || startedBefore ? 1_000 : null,
    status: resultStatus,
    terminalAt:
      resultStatus === 'succeeded' || resultStatus === 'failed' || resultStatus === 'cancelled'
        ? 1_500
        : null,
    updatedAt: 1_500,
  });
  return {
    attempt,
    command: {
      authority: authority(0, 1, 0),
      expected: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [attemptExpectation(attempt)],
        nodes: [nodeExpectation(node)],
        run: runExpectation(run),
      },
      idempotency: idempotency(
        operation === 'start' ? 'start_attempt' : operation,
        run.id,
        attempt.id,
      ),
      kind: 'apply_incumbent_transition',
      operation,
      transition: transitionFixture({
        attempts: [nextAttempt],
        nodes: [nextNode],
        run: nextRun,
      }),
    },
    node,
    run,
  };
};

const claimCase = () => {
  const run = runFixture();
  const node = nodeFixture();
  const attempt = attemptFixture();
  const command: RunStoreClaimAttemptCommand = {
    expected: {
      absentAttemptId: attempt.id,
      absentNodes: [],
      absentOutputIds: [],
      node: nodeExpectation(node),
      run: runExpectation(run),
    },
    idempotency: idempotency('claim_attempt', run.id, node.id),
    kind: 'claim_attempt',
    leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
    operation: 'claim',
    transition: claimTransitionFixture(run, node, attempt),
  };
  return { attempt, command, node, run };
};

const handoffCase = () => {
  const run = runFixture();
  const node = executingNodeFixture('executing', { revision: 1 });
  const attempt = attemptFixture();
  const command: RunStoreWriteHandoffCommand = {
    authority: authority(0, 1, 0),
    expected: {
      attempt: attemptExpectation(attempt),
      node: nodeExpectation(node),
      run: runExpectation(run),
    },
    handoffId: 'handoff-1',
    idempotency: idempotency('write_handoff', run.id, attempt.id),
    kind: 'write_handoff',
    reason: 'manager_shutdown',
  };
  return { attempt, command, node, run };
};

const acquisitionCase = (attemptStatus: 'claimed' | 'start_committed' = 'claimed') => {
  const run = runFixture();
  const node = executingNodeFixture('executing', { revision: 1 });
  const attempt = attemptFixture({ status: attemptStatus });
  const changesUnknownOutcome = attemptStatus === 'start_committed';
  const nextRun = changesUnknownOutcome ? runFixture({ revision: 1, updatedAt: 3_000 }) : run;
  const nextNode = changesUnknownOutcome
    ? executingNodeFixture('unknown', { revision: 2, updatedAt: 3_000 })
    : node;
  const command: RunStoreAcquireAttemptCommand = {
    change: {
      attempt: attemptFixture({
        fault: changesUnknownOutcome
          ? { code: 'UNKNOWN_OUTCOME', message: 'Outcome is unknown.' }
          : attempt.fault,
        fencingToken: 2,
        lastHeartbeatAt: 3_000,
        leaseExpiresAt: 5_000,
        managerIncarnationId: 'manager-2',
        revision: 1,
        status: changesUnknownOutcome ? 'unknown' : 'claimed',
        updatedAt: 3_000,
      }),
      node: nextNode,
      run: nextRun,
    },
    evidence: { kind: 'lease_expired' },
    expected: {
      attempt: attemptExpectation(attempt),
      node: nodeExpectation(node),
      run: runExpectation(run),
    },
    idempotency: idempotency('acquire_attempt', run.id, attempt.id),
    kind: 'acquire_attempt',
    leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
    successorManagerIncarnationId: 'manager-2',
  };
  return { attempt, command, node, run };
};

const identityCommandCases = (): readonly RunStoreCommitCommand[] => {
  const run = runFixture();
  const node = executingNodeFixture('executing', { revision: 1 });
  const attempt = attemptFixture();
  const expected = {
    absentAttemptIds: [] as const,
    absentNodes: [] as const,
    absentOutputIds: [] as const,
    attempts: [attemptExpectation(attempt)] as const,
    nodes: [nodeExpectation(node)] as const,
    run: runExpectation(run),
  };
  const claimNode = nodeFixture();
  const claimAttempt = attemptFixture({
    createdAt: 1_500,
    lastHeartbeatAt: 1_500,
    leaseExpiresAt: 3_500,
    updatedAt: 1_500,
  });
  const claim: RunStoreClaimAttemptCommand = {
    expected: {
      absentAttemptId: 'attempt-1',
      absentNodes: [],
      absentOutputIds: [],
      node: nodeExpectation(claimNode),
      run: runExpectation(run),
    },
    idempotency: idempotency('claim_attempt', run.id, 'node-1'),
    kind: 'claim_attempt',
    leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
    operation: 'claim',
    transition: claimTransitionFixture(run, claimNode, claimAttempt),
  };
  const unowned = (operation: RunStoreUnownedOperation): RunStoreUnownedTransitionCommand => ({
    expected: {
      absentAttemptIds: [],
      absentNodes: [],
      absentOutputIds: [],
      attempts: [],
      nodes: [nodeExpectation(node)],
      run: runExpectation(run),
    },
    idempotency:
      operation === 'gate_answer'
        ? idempotency('answer_gate', run.id, node.activationId)
        : operation === 'request_cancellation'
          ? idempotency('cancel_run', run.id, null)
          : null,
    kind: 'apply_unowned_transition',
    operation,
    transition: transitionFixture({ nodes: [node], run }),
  });
  const handoff: RunStoreWriteHandoffCommand = {
    authority: authority(0, 1, 0),
    expected: {
      attempt: attemptExpectation(attempt),
      node: nodeExpectation(node),
      run: runExpectation(run),
    },
    handoffId: 'handoff-1',
    idempotency: idempotency('write_handoff', run.id, attempt.id),
    kind: 'write_handoff',
    reason: 'manager_shutdown',
  };
  const acquisition: RunStoreAcquireAttemptCommand = {
    change: {
      attempt: attemptFixture({
        fencingToken: 2,
        lastHeartbeatAt: 1_500,
        leaseExpiresAt: 3_500,
        managerIncarnationId: 'manager-2',
        revision: 1,
        updatedAt: 1_500,
      }),
      node,
      run,
    },
    evidence: { kind: 'lease_expired' },
    expected: {
      attempt: attemptExpectation(attempt),
      node: nodeExpectation(node),
      run: runExpectation(run),
    },
    idempotency: idempotency('acquire_attempt', run.id, attempt.id),
    kind: 'acquire_attempt',
    leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
    successorManagerIncarnationId: 'manager-2',
  };
  const renewal: RunStoreRenewLeaseTransitionCommand = {
    authority: authority(0, 1, 0),
    expected,
    idempotency: null,
    kind: 'apply_incumbent_transition',
    leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
    operation: 'renew_lease',
    transition: transitionFixture({
      attempts: [
        attemptFixture({
          lastHeartbeatAt: 1_500,
          leaseExpiresAt: 3_500,
          revision: 1,
          updatedAt: 1_500,
        }),
      ],
      nodes: [node],
      run,
    }),
  };
  return [
    createCommand(),
    claim,
    ...(
      [
        'activate_nodes',
        'gate_answer',
        'join_ready',
        'join_succeeded',
        'request_cancellation',
      ] as const
    ).map(unowned),
    ...(
      [
        'start',
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
      ] as const
    ).map((operation) => incumbentCase(operation).command),
    renewal,
    handoff,
    acquisition,
  ];
};

describe('logical RunStore conformance', () => {
  it.each([-1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    'rejects invalid transactionNow %s',
    (transactionNow) => {
      expect(() => new LogicalRunStoreFake(transactionNow)).toThrow('nonnegative safe integer');
    },
  );

  it('rejects required/null and every identity-axis mismatch for every operation', async () => {
    await Promise.all(
      identityCommandCases().map(async (command) => {
        const store = new LogicalRunStoreFake(command.kind === 'create_run' ? 1_000 : 1_500);
        const result = await store.transaction(async (transaction) => transaction.commit(command));
        expect(result.kind).not.toBe('invalid_input');
      }),
    );
    const cases = identityCommandCases().flatMap((command) => {
      const write = command.idempotency;
      const withWrite = (replacement: typeof write): RunStoreCommitCommand => {
        const variant = structuredClone(command);
        Reflect.set(variant, 'idempotency', replacement);
        return variant;
      };
      if (write === null) {
        return [{ command: withWrite(idempotency('start_run', null, null, 'unexpected')) }];
      }
      const withIdentityField = (
        field: 'operation' | 'runId' | 'subjectId',
        value: string,
      ): RunStoreCommitCommand => {
        const replacement = structuredClone(write);
        Reflect.set(replacement.identity, field, value);
        return withWrite(replacement);
      };
      return [
        withWrite(null),
        withIdentityField(
          'operation',
          write.identity.operation === 'start_run' ? 'claim_attempt' : 'start_run',
        ),
        withIdentityField('runId', 'wrong-run'),
        withIdentityField('subjectId', 'wrong-subject'),
      ].map((variant) => ({ command: variant }));
    });
    await Promise.all(
      cases.map(async ({ command }) => {
        const store = new LogicalRunStoreFake(command.kind === 'create_run' ? 1_000 : 1_500);
        await expect(
          store.transaction(async (transaction) => transaction.commit(command)),
        ).resolves.toMatchObject({ kind: 'invalid_input' });
      }),
    );
  });

  it('atomically creates and reads back Run, nodes, outputs, events, and idempotency', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const command = createCommand();
    const result = await store.transaction(async (transaction) => transaction.commit(command));

    expect(result).toMatchObject({
      cursor: { runId: 'run-1', sequence: 1 },
      kind: 'committed',
      materializedEvents: [
        {
          createdAt: 1_000,
          cursor: { runId: 'run-1', sequence: 1 },
          sequence: 1,
        },
      ],
    });
    await store.transaction(async (transaction) => {
      await expect(transaction.getNode('run-1-node')).resolves.toMatchObject({
        kind: 'found',
      });
      await expect(
        transaction.listOutputs({
          activationId: null,
          attemptId: null,
          cursor: null,
          limit: 10,
          names: [],
          nodeInstanceId: null,
          runId: 'run-1',
        }),
      ).resolves.toMatchObject({
        kind: 'page',
        page: { items: [{ id: 'run-1-output' }] },
      });
      await expect(transaction.getIdempotency(command.idempotency.identity)).resolves.toMatchObject(
        { kind: 'found' },
      );
    });
    await expect(
      store.readEvents({
        limit: 10,
        runId: 'run-1',
        scan: { after: { runId: 'run-1', sequence: 0 }, kind: 'start' },
      }),
    ).resolves.toMatchObject({
      kind: 'page',
      page: { highWatermark: { sequence: 1 }, items: [{ sequence: 1 }] },
    });
  });

  it('stores immutable defensive snapshots', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const command = createCommand();
    await store.transaction(async (transaction) => transaction.commit(command));

    const stored = await store.getRun('run-1');
    expect(Object.isFrozen(stored.kind === 'found' ? stored.value : null)).toBe(true);
    expect(Object.isFrozen(command.idempotency.request)).toBe(false);
  });

  it('validates idempotency binding before observing an existing record', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const command = createCommand();
    await store.transaction(async (transaction) => transaction.commit(command));
    const malformed: RunStoreCreateRunCommand = {
      ...command,
      idempotency: {
        ...command.idempotency,
        identity: {
          ...command.idempotency.identity,
          runId: 'must-be-null',
        },
      },
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects a missing gate identity and invalid policy before idempotency lookup', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const run = runFixture();
    const gate = nodeFixture({ status: 'gate_waiting' });
    store.seed({ nodes: [gate], runs: [run] });
    const answered = nodeFixture({
      id: gate.id,
      revision: 1,
      status: 'succeeded',
      terminalAt: 1_000,
    });
    const missingIdentity: RunStoreUnownedTransitionCommand = {
      expected: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [],
        nodes: [nodeExpectation(gate)],
        run: runExpectation(run),
      },
      idempotency: null,
      kind: 'apply_unowned_transition',
      operation: 'gate_answer',
      transition: transitionFixture({
        nodes: [answered],
        run: runFixture({ revision: 1 }),
      }),
    };
    await expect(
      store.transaction(async (transaction) => transaction.commit(missingIdentity)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const ready = nodeFixture();
    const claimAttempt = attemptFixture();
    const claimStore = new LogicalRunStoreFake(1_000);
    claimStore.seed({ nodes: [ready], runs: [run] });
    const validClaim: RunStoreClaimAttemptCommand = {
      expected: {
        absentAttemptId: 'attempt-1',
        absentNodes: [],
        absentOutputIds: [],
        node: nodeExpectation(ready),
        run: runExpectation(run),
      },
      idempotency: idempotency('claim_attempt', run.id, ready.id),
      kind: 'claim_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      operation: 'claim',
      transition: claimTransitionFixture(run, ready, claimAttempt),
    };
    await claimStore.transaction(async (transaction) => transaction.commit(validClaim));
    const invalidReplay: RunStoreClaimAttemptCommand = {
      ...validClaim,
      leasePolicy: { heartbeatIntervalMs: 99, leaseDurationMs: 1_000 },
    };
    await expect(
      claimStore.transaction(async (transaction) => transaction.commit(invalidReplay)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects a malformed claim before replaying a seeded identical identity', async () => {
    const seeded = claimCase();
    const seededStore = new LogicalRunStoreFake(1_000);
    seededStore.seed({ nodes: [seeded.node], runs: [seeded.run] });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    const malformed: RunStoreClaimAttemptCommand = {
      ...seeded.command,
      leasePolicy: { heartbeatIntervalMs: 99, leaseDurationMs: 1_000 },
    };
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(1_000);
    noRecordStore.seed({ nodes: [seeded.node], runs: [seeded.run] });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it.each([
    [
      'wrong claimed status',
      (command: RunStoreClaimAttemptCommand): RunStoreClaimAttemptCommand => ({
        ...command,
        transition: {
          ...command.transition,
          attempts: [{ ...command.transition.attempts[0]!, status: 'start_committed' }],
        },
      }),
    ],
    [
      'swapped events',
      (command: RunStoreClaimAttemptCommand): RunStoreClaimAttemptCommand => ({
        ...command,
        transition: {
          ...command.transition,
          eventIntents: [command.transition.eventIntents[1]!, command.transition.eventIntents[0]!],
        },
      }),
    ],
    [
      'wrong event',
      (command: RunStoreClaimAttemptCommand): RunStoreClaimAttemptCommand => ({
        ...command,
        transition: {
          ...command.transition,
          eventIntents: [command.transition.eventIntents[0]!, command.transition.eventIntents[0]!],
        },
      }),
    ],
    [
      'wrong active Attempt pointer',
      (command: RunStoreClaimAttemptCommand): RunStoreClaimAttemptCommand => ({
        ...command,
        transition: {
          ...command.transition,
          nodes: [{ ...command.transition.nodes[0]!, activeAttemptId: 'wrong-attempt' }],
        },
      }),
    ],
    [
      'wrong node status',
      (command: RunStoreClaimAttemptCommand): RunStoreClaimAttemptCommand => ({
        ...command,
        transition: {
          ...command.transition,
          nodes: [{ ...command.transition.nodes[0]!, status: 'ready' }],
        },
      }),
    ],
  ] as const)('rejects claim %s before identical replay lookup', async (_case, mutate) => {
    const seeded = claimCase();
    const malformed = mutate(seeded.command);
    const seededStore = new LogicalRunStoreFake(1_000);
    seededStore.seed({ nodes: [seeded.node], runs: [seeded.run] });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(1_000);
    noRecordStore.seed({ nodes: [seeded.node], runs: [seeded.run] });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects a malformed incumbent transition before replaying a seeded identical identity', async () => {
    const seeded = incumbentCase('start');
    const seededStore = new LogicalRunStoreFake(1_500);
    seededStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    const malformed: RunStoreCommitCommand = { ...seeded.command };
    Object.defineProperty(malformed, 'leasePolicy', {
      enumerable: true,
      value: undefined,
    });
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(1_500);
    noRecordStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it.each([
    'start',
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
  ] as const)('rejects %s wrong target before identical replay lookup', async (operation) => {
    const seeded = incumbentCase(operation);
    const malformed: RunStoreNonRenewIncumbentTransitionCommand = {
      ...seeded.command,
      transition: {
        ...seeded.command.transition,
        attempts: [{ ...seeded.command.transition.attempts[0]!, status: 'claimed' }],
      },
    };
    const seededStore = new LogicalRunStoreFake(1_500);
    seededStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(1_500);
    noRecordStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it.each([
    ['start', 'run', 1],
    ['begin_reconciliation', 'node', 2],
    ['reconciled_unknown', 'run', 1],
    ['direct_success', 'run', 0],
    ['late_failure', 'node', 1],
  ] as const)(
    'rejects %s wrong %s revision pattern before identical replay lookup',
    async (operation, entity, revision) => {
      const seeded = incumbentCase(operation);
      const malformed: RunStoreNonRenewIncumbentTransitionCommand = {
        ...seeded.command,
        transition: {
          ...seeded.command.transition,
          nodes:
            entity === 'node'
              ? [{ ...seeded.command.transition.nodes[0]!, revision }]
              : seeded.command.transition.nodes,
          run:
            entity === 'run'
              ? { ...seeded.command.transition.run, revision }
              : seeded.command.transition.run,
        },
      };
      const seededStore = new LogicalRunStoreFake(1_500);
      seededStore.seed({
        attempts: [seeded.attempt],
        nodes: [seeded.node],
        runs: [seeded.run],
      });
      await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
      await expect(
        seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
      ).resolves.toMatchObject({ kind: 'replayed' });
      await expect(
        seededStore.transaction(async (transaction) => transaction.commit(malformed)),
      ).resolves.toMatchObject({ kind: 'invalid_input' });

      const noRecordStore = new LogicalRunStoreFake(1_500);
      noRecordStore.seed({
        attempts: [seeded.attempt],
        nodes: [seeded.node],
        runs: [seeded.run],
      });
      await expect(
        noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
      ).resolves.toMatchObject({ kind: 'invalid_input' });
    },
  );

  it('rejects malformed acquisition before replaying a seeded identical identity', async () => {
    const seeded = acquisitionCase();
    const seededStore = new LogicalRunStoreFake(3_000);
    seededStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    const malformed: RunStoreAcquireAttemptCommand = {
      ...seeded.command,
      change: {
        ...seeded.command.change,
        node: { ...seeded.command.change.node, id: 'wrong-node' },
      },
    };
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(3_000);
    noRecordStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects acquisition successor-incarnation mismatch before identical replay lookup', async () => {
    const seeded = acquisitionCase();
    const malformed: RunStoreAcquireAttemptCommand = {
      ...seeded.command,
      successorManagerIncarnationId: 'manager-3',
    };
    const seededStore = new LogicalRunStoreFake(3_000);
    seededStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(3_000);
    noRecordStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects acquisition that reuses the supplied incumbent incarnation before replay lookup', async () => {
    const seeded = acquisitionCase();
    const malformed: RunStoreAcquireAttemptCommand = {
      ...seeded.command,
      change: {
        ...seeded.command.change,
        attempt: {
          ...seeded.command.change.attempt,
          managerIncarnationId: seeded.command.expected.attempt.managerIncarnationId,
        },
      },
      successorManagerIncarnationId: seeded.command.expected.attempt.managerIncarnationId,
    };
    const seededStore = new LogicalRunStoreFake(3_000);
    seededStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(3_000);
    noRecordStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects malformed handoff before replaying a seeded identical identity', async () => {
    const seeded = handoffCase();
    const seededStore = new LogicalRunStoreFake(1_500);
    seededStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await seededStore.transaction(async (transaction) => transaction.commit(seeded.command));
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(seeded.command)),
    ).resolves.toMatchObject({ kind: 'replayed' });
    const malformed: RunStoreWriteHandoffCommand = { ...seeded.command, handoffId: '' };
    await expect(
      seededStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });

    const noRecordStore = new LogicalRunStoreFake(1_500);
    noRecordStore.seed({
      attempts: [seeded.attempt],
      nodes: [seeded.node],
      runs: [seeded.run],
    });
    await expect(
      noRecordStore.transaction(async (transaction) => transaction.commit(malformed)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('serializes concurrent transactions without losing unrelated committed runs', async () => {
    const store = new LogicalRunStoreFake(1_000);
    await Promise.all([
      store.transaction(async (transaction) => transaction.commit(createCommand('run-a', 'a'))),
      store.transaction(async (transaction) => transaction.commit(createCommand('run-b', 'b'))),
    ]);

    await expect(store.getRun('run-a')).resolves.toMatchObject({ kind: 'found' });
    await expect(store.getRun('run-b')).resolves.toMatchObject({ kind: 'found' });
  });

  it.each([
    ['global node id', { id: 'run-2-node', activationId: 'other' }, 'REVISION_CONFLICT'],
    ['Run activation id', { id: 'other-node', activationId: 'activation-1' }, 'STALE_ACTIVATION'],
    ['scoped activation key', { id: 'other-node', activationId: 'other' }, 'STALE_ACTIVATION'],
  ] as const)(
    'enforces new-node triple uniqueness for %s collisions',
    async (_case, existingOverrides, expectedCode) => {
      const store = new LogicalRunStoreFake(1_000);
      const command = createCommand('run-2');
      const prospective = command.nodes[0];
      if (prospective === undefined) throw new Error('Expected prospective node.');
      const scopeCollision =
        expectedCode === 'STALE_ACTIVATION' && existingOverrides.activationId === 'other'
          ? { activationKey: prospective.activationKey }
          : {};
      const existing = nodeFixture({
        activationId: existingOverrides.activationId,
        forkScopeKey: prospective.forkScopeKey,
        id: existingOverrides.id,
        runId: 'run-2',
        ...scopeCollision,
      });
      store.seed({ nodes: [existing] });

      await expect(
        store.transaction(async (transaction) => transaction.commit(command)),
      ).resolves.toMatchObject({
        conflict: { code: expectedCode },
        kind: 'conflict',
      });
    },
  );

  it('rolls back every staged artifact on injected provider failure', async () => {
    const store = new LogicalRunStoreFake(1_000);
    store.failAfterNextCommit();
    await expect(
      store.transaction(async (transaction) => transaction.commit(createCommand())),
    ).rejects.toThrow('Injected logical provider failure');

    await expect(store.getRun('run-1')).resolves.toEqual({ kind: 'not_found' });
  });

  it.each(['run', 'nodes', 'outputs', 'events', 'idempotency'] as const)(
    'rolls back create after the %s materialization stage',
    async (stage) => {
      const store = new LogicalRunStoreFake(1_000);
      store.failAfterNextStage(stage);
      await expect(
        store.transaction(async (transaction) => transaction.commit(createCommand())),
      ).rejects.toThrow(`after ${stage}`);
      await expect(store.getRun('run-1')).resolves.toEqual({ kind: 'not_found' });
    },
  );

  it('rolls back claim after Attempt materialization', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const run = runFixture();
    const node = nodeFixture();
    const attempt = attemptFixture();
    store.seed({ nodes: [node], runs: [run] });
    const command: RunStoreClaimAttemptCommand = {
      expected: {
        absentAttemptId: 'attempt-1',
        absentNodes: [],
        absentOutputIds: [],
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      idempotency: idempotency('claim_attempt', run.id, node.id),
      kind: 'claim_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      operation: 'claim',
      transition: claimTransitionFixture(run, node, attempt),
    };
    store.failAfterNextStage('attempts');

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).rejects.toThrow('after attempts');
    await store.transaction(async (transaction) => {
      await expect(transaction.getAttempt('attempt-1')).resolves.toEqual({
        kind: 'not_found',
      });
      await expect(transaction.getNode(node.id)).resolves.toMatchObject({
        kind: 'found',
        value: { activeAttemptId: null, revision: 0 },
      });
    });
  });

  it('claims an Attempt and active pointer atomically with lease policy', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const run = runFixture();
    const node = nodeFixture();
    store.seed({ nodes: [node], runs: [run] });
    const attempt = attemptFixture({ leaseExpiresAt: 3_000 });
    const command: RunStoreClaimAttemptCommand = {
      expected: {
        absentAttemptId: attempt.id,
        absentNodes: [],
        absentOutputIds: [],
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      idempotency: idempotency('claim_attempt', run.id, node.id),
      kind: 'claim_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      operation: 'claim',
      transition: claimTransitionFixture(run, node, attempt),
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({
      kind: 'committed',
      materializedEvents: [
        { kind: 'attempt.created', sequence: 1 },
        { kind: 'node.transitioned', sequence: 2 },
      ],
    });
    await store.transaction(async (transaction) => {
      await expect(transaction.getNode(node.id)).resolves.toMatchObject({
        kind: 'found',
        value: { activeAttemptId: attempt.id, revision: 1 },
      });
      await expect(transaction.getAttempt(attempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { fencingToken: 1, status: 'claimed' },
      });
    });
  });

  it.each([
    [{ heartbeatIntervalMs: 100, leaseDurationMs: 999 }, 1_000],
    [{ heartbeatIntervalMs: 99, leaseDurationMs: 1_000 }, 1_000],
    [{ heartbeatIntervalMs: 1_000, leaseDurationMs: 1_000 }, 1_000],
    [{ heartbeatIntervalMs: 100, leaseDurationMs: 86_400_001 }, 1_000],
    [{ heartbeatIntervalMs: 100, leaseDurationMs: 1_000 }, Number.MAX_SAFE_INTEGER - 999],
  ] as const)('rejects invalid or overflowing claim LeasePolicy %#', async (policy, now) => {
    const store = new LogicalRunStoreFake(now);
    const run = runFixture();
    const node = nodeFixture();
    store.seed({ nodes: [node], runs: [run] });
    const command: RunStoreClaimAttemptCommand = {
      expected: {
        absentAttemptId: 'attempt-1',
        absentNodes: [],
        absentOutputIds: [],
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      idempotency: idempotency('claim_attempt', run.id, node.id),
      kind: 'claim_attempt',
      leasePolicy: policy,
      operation: 'claim',
      transition: transitionFixture({
        attempts: [attemptFixture()],
        nodes: [executingNodeFixture('executing', { revision: 1 })],
        run: runFixture({ revision: 1 }),
      }),
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('applies A3 renewal with null idempotency and exact DB-time lease extension', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const attempt = attemptFixture();
    store.seed({ attempts: [attempt], nodes: [node], runs: [run] });
    const nextAttempt = attemptFixture({
      lastHeartbeatAt: 1_500,
      leaseExpiresAt: 3_500,
      revision: 1,
      updatedAt: 1_500,
    });
    const command: RunStoreRenewLeaseTransitionCommand = {
      authority: authority(0, 1, 0),
      expected: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [attemptExpectation(attempt)],
        nodes: [nodeExpectation(node)],
        run: runExpectation(run),
      },
      idempotency: null,
      kind: 'apply_incumbent_transition',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      operation: 'renew_lease',
      transition: transitionFixture({
        attempts: [nextAttempt],
        nodes: [node],
        run,
      }),
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({ kind: 'committed' });
    await store.transaction(async (transaction) => {
      await expect(transaction.getAttempt(attempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { lastHeartbeatAt: 1_500, leaseExpiresAt: 3_500, revision: 1 },
      });
    });
  });

  it.each([
    'start',
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
  ] as const)('commits the %s incumbent variant with its exact identity', async (operation) => {
    const store = new LogicalRunStoreFake(1_500);
    const fixture = incumbentCase(operation);
    store.seed({
      attempts: [fixture.attempt],
      nodes: [fixture.node],
      runs: [fixture.run],
    });

    await expect(
      store.transaction(async (transaction) => transaction.commit(fixture.command)),
    ).resolves.toMatchObject({ kind: 'committed' });
  });

  it.each([
    'start',
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
  ] as const)('rejects an incompatible source pair for %s', async (operation) => {
    const fixture = incumbentCase(operation);
    const expectedSource = fixture.attempt.status;
    const incompatibleStatus =
      expectedSource === 'claimed'
        ? 'start_committed'
        : expectedSource === 'start_committed'
          ? 'claimed'
          : expectedSource === 'unknown'
            ? 'reconciling'
            : 'unknown';
    const incompatibleNode = executingNodeFixture(
      incompatibleStatus === 'unknown' || incompatibleStatus === 'reconciling'
        ? 'unknown'
        : 'executing',
      { revision: 1 },
    );
    const incompatibleAttempt = attemptFixture({ status: incompatibleStatus });
    const command: RunStoreNonRenewIncumbentTransitionCommand = {
      ...fixture.command,
      expected: {
        ...fixture.command.expected,
        attempts: [attemptExpectation(incompatibleAttempt)],
        nodes: [nodeExpectation(incompatibleNode)],
      },
    };
    const store = new LogicalRunStoreFake(1_500);
    store.seed({
      attempts: [incompatibleAttempt],
      nodes: [incompatibleNode],
      runs: [fixture.run],
    });

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it.each([
    'activate_nodes',
    'gate_answer',
    'join_ready',
    'join_succeeded',
    'request_cancellation',
  ] as const)('commits the %s unowned variant', async (operation: RunStoreUnownedOperation) => {
    const store = new LogicalRunStoreFake(1_500);
    const run = runFixture();
    const sourceStatus =
      operation === 'gate_answer'
        ? 'gate_waiting'
        : operation === 'join_ready' || operation === 'join_succeeded'
          ? 'join_waiting'
          : 'ready';
    const sourceNode = nodeFixture({ status: sourceStatus });
    store.seed({
      nodes: operation === 'activate_nodes' ? [] : [sourceNode],
      runs: [run],
    });
    const resultStatus =
      operation === 'join_ready'
        ? 'ready'
        : operation === 'activate_nodes'
          ? 'ready'
          : operation === 'request_cancellation'
            ? 'cancelled'
            : 'succeeded';
    const resultNode =
      operation === 'activate_nodes'
        ? nodeFixture({
            activationId: 'new-activation',
            id: 'new-node',
            updatedAt: 1_500,
            createdAt: 1_500,
          })
        : nodeFixture({
            activeAttemptId: null,
            id: sourceNode.id,
            revision: 1,
            status: resultStatus,
            terminalAt: resultStatus === 'succeeded' || resultStatus === 'cancelled' ? 1_500 : null,
            updatedAt: 1_500,
          });
    const resultRun = runFixture({
      cancellationRequestedAt: operation === 'request_cancellation' ? 1_500 : null,
      revision: 1,
      status: operation === 'request_cancellation' ? 'cancelling' : 'running',
      updatedAt: 1_500,
    });
    const requiredIdempotency =
      operation === 'gate_answer'
        ? idempotency('answer_gate', run.id, sourceNode.activationId)
        : operation === 'request_cancellation'
          ? idempotency('cancel_run', run.id, null)
          : null;
    const gateOutput =
      operation === 'gate_answer'
        ? outputFixture({
            correlation: {
              activationId: sourceNode.activationId,
              kind: 'node',
              nodeInstanceId: sourceNode.id,
            },
            createdAt: 1_500,
          })
        : null;
    const command: RunStoreUnownedTransitionCommand = {
      expected: {
        absentAttemptIds: [],
        absentNodes:
          operation === 'activate_nodes'
            ? [
                {
                  activationId: resultNode.activationId,
                  activationKey: resultNode.activationKey,
                  forkScopeKey: resultNode.forkScopeKey,
                  nodeInstanceId: resultNode.id,
                  runId: resultNode.runId,
                },
              ]
            : [],
        absentOutputIds: gateOutput === null ? [] : [gateOutput.id],
        attempts: [],
        nodes: operation === 'activate_nodes' ? [] : [nodeExpectation(sourceNode)],
        run: runExpectation(run),
      },
      idempotency: requiredIdempotency,
      kind: 'apply_unowned_transition',
      operation,
      transition: transitionFixture({
        nodes: [resultNode],
        outputs: gateOutput === null ? [] : [gateOutput],
        run: resultRun,
      }),
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({ kind: 'committed' });
  });

  it('rejects incumbent renewal at lease equality', async () => {
    const store = new LogicalRunStoreFake(3_000);
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const attempt = attemptFixture();
    store.seed({ attempts: [attempt], nodes: [node], runs: [run] });
    const command: RunStoreRenewLeaseTransitionCommand = {
      authority: authority(0, 1, 0),
      expected: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [attemptExpectation(attempt)],
        nodes: [nodeExpectation(node)],
        run: runExpectation(run),
      },
      idempotency: null,
      kind: 'apply_incumbent_transition',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      operation: 'renew_lease',
      transition: transitionFixture({
        attempts: [
          attemptFixture({
            lastHeartbeatAt: 3_000,
            leaseExpiresAt: 5_000,
            revision: 1,
            updatedAt: 3_000,
          }),
        ],
        nodes: [node],
        run,
      }),
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({
      conflict: { code: 'STALE_FENCE' },
      kind: 'conflict',
    });
  });

  it.each([
    ['one-before-expiry', 2_999, 'manager-1', false, 'committed'],
    ['foreign-incarnation', 1_500, 'manager-foreign', false, 'conflict'],
    ['handoff-present', 1_500, 'manager-1', true, 'conflict'],
  ] as const)(
    'enforces renewal authority for %s',
    async (_case, transactionNow, managerIncarnationId, withHandoff, expectedKind) => {
      const store = new LogicalRunStoreFake(transactionNow);
      const run = runFixture();
      const node = executingNodeFixture('executing', { revision: 1 });
      const attempt = attemptFixture();
      const nextAttempt = attemptFixture({
        lastHeartbeatAt: transactionNow,
        leaseExpiresAt: transactionNow + 2_000,
        revision: 1,
        updatedAt: transactionNow,
      });
      const handoff: AttemptHandoffState = {
        consumption: null,
        handoff: {
          activationId: node.activationId,
          createdAt: 1_250,
          expectedAttemptRevision: attempt.revision,
          id: 'handoff-renewal',
          incumbentManagerIncarnationId: attempt.managerIncarnationId,
          key: {
            attemptId: attempt.id,
            incumbentFencingToken: attempt.fencingToken,
          },
          nodeInstanceId: node.id,
          reason: 'manager_shutdown',
          runId: run.id,
        },
      };
      store.seed({
        attempts: [attempt],
        handoffs: withHandoff ? [handoff] : [],
        nodes: [node],
        runs: [run],
      });
      const command: RunStoreRenewLeaseTransitionCommand = {
        authority: {
          ...authority(0, 1, 0),
          managerIncarnationId,
        },
        expected: {
          absentAttemptIds: [],
          absentNodes: [],
          absentOutputIds: [],
          attempts: [attemptExpectation(attempt)],
          nodes: [nodeExpectation(node)],
          run: runExpectation(run),
        },
        idempotency: null,
        kind: 'apply_incumbent_transition',
        leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
        operation: 'renew_lease',
        transition: transitionFixture({
          attempts: [nextAttempt],
          nodes: [node],
          run,
        }),
      };

      await expect(
        store.transaction(async (transaction) => transaction.commit(command)),
      ).resolves.toMatchObject({ kind: expectedKind });
    },
  );

  it('records fence-scoped handoff, invalidates incumbent writes, and exposes history', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const attempt = attemptFixture();
    store.seed({ attempts: [attempt], nodes: [node], runs: [run] });
    const command: RunStoreWriteHandoffCommand = {
      authority: authority(0, 1, 0),
      expected: {
        attempt: attemptExpectation(attempt),
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      handoffId: 'handoff-1',
      idempotency: idempotency('write_handoff', run.id, attempt.id),
      kind: 'write_handoff',
      reason: 'manager_shutdown',
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({
      kind: 'committed',
      materializedEvents: [{ kind: 'attempt.handoff_recorded' }],
    });
    await store.transaction(async (transaction) => {
      await expect(
        transaction.getHandoff({
          attemptId: attempt.id,
          incumbentFencingToken: attempt.fencingToken,
        }),
      ).resolves.toMatchObject({
        kind: 'found',
        value: { consumption: null, handoff: { id: 'handoff-1' } },
      });
    });
    await expect(
      store.transaction(async (transaction) => transaction.commit(incumbentCase('start').command)),
    ).resolves.toMatchObject({
      conflict: { code: 'STALE_FENCE' },
      kind: 'conflict',
    });
  });

  it('rolls back handoff history and event materialization on provider failure', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const attempt = attemptFixture();
    store.seed({ attempts: [attempt], nodes: [node], runs: [run] });
    const command: RunStoreWriteHandoffCommand = {
      authority: authority(0, 1, 0),
      expected: {
        attempt: attemptExpectation(attempt),
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      handoffId: 'handoff-1',
      idempotency: idempotency('write_handoff', run.id, attempt.id),
      kind: 'write_handoff',
      reason: 'manager_shutdown',
    };
    store.failAfterNextStage('handoff');

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).rejects.toThrow('after handoff');
    await store.transaction(async (transaction) => {
      await expect(
        transaction.getHandoff({
          attemptId: attempt.id,
          incumbentFencingToken: attempt.fencingToken,
        }),
      ).resolves.toEqual({ kind: 'not_found' });
    });
  });

  it('consumes one named handoff exactly once and preserves immutable history', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const attempt = attemptFixture();
    store.seed({ attempts: [attempt], nodes: [node], runs: [run] });
    const write: RunStoreWriteHandoffCommand = {
      authority: authority(0, 1, 0),
      expected: {
        attempt: attemptExpectation(attempt),
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      handoffId: 'handoff-1',
      idempotency: idempotency('write_handoff', run.id, attempt.id),
      kind: 'write_handoff',
      reason: 'manager_shutdown',
    };
    await store.transaction(async (transaction) => transaction.commit(write));
    const nextAttempt = attemptFixture({
      fencingToken: 2,
      lastHeartbeatAt: 1_500,
      leaseExpiresAt: 3_500,
      managerIncarnationId: 'manager-2',
      revision: 1,
      updatedAt: 1_500,
    });
    const command: RunStoreAcquireAttemptCommand = {
      change: { attempt: nextAttempt, node, run },
      evidence: { handoffId: 'handoff-1', kind: 'handoff' },
      expected: {
        attempt: {
          ...attemptExpectation(attempt),
          handoff: {
            handoffId: 'handoff-1',
            key: { attemptId: attempt.id, incumbentFencingToken: 1 },
            kind: 'named',
          },
        },
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      idempotency: idempotency('acquire_attempt', run.id, attempt.id),
      kind: 'acquire_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      successorManagerIncarnationId: 'manager-2',
    };

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({
      kind: 'committed',
      takeover: {
        evidence: 'handoff',
        handoffConsumption: {
          consumedAt: 1_500,
          successorFencingToken: 2,
        },
      },
    });
    await store.transaction(async (transaction) => {
      await expect(
        transaction.getHandoff({
          attemptId: attempt.id,
          incumbentFencingToken: 1,
        }),
      ).resolves.toMatchObject({
        kind: 'found',
        value: {
          consumption: { handoffId: 'handoff-1' },
          handoff: { id: 'handoff-1' },
        },
      });
    });
    const changedKey = {
      ...command,
      idempotency: {
        ...command.idempotency,
        identity: { ...command.idempotency.identity, key: 'acquire-again' },
      },
    };
    await expect(
      store.transaction(async (transaction) => transaction.commit(changedKey)),
    ).resolves.toMatchObject({
      conflict: { code: 'STALE_FENCE' },
      kind: 'conflict',
    });
  });

  it('rolls back handoff consumption and successor fence on provider failure', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const attempt = attemptFixture();
    const handoff: AttemptHandoffState = {
      consumption: null,
      handoff: {
        activationId: node.activationId,
        createdAt: 1_400,
        expectedAttemptRevision: attempt.revision,
        id: 'handoff-1',
        incumbentManagerIncarnationId: attempt.managerIncarnationId,
        key: { attemptId: attempt.id, incumbentFencingToken: 1 },
        nodeInstanceId: node.id,
        reason: 'manager_shutdown',
        runId: run.id,
      },
    };
    store.seed({ attempts: [attempt], handoffs: [handoff], nodes: [node], runs: [run] });
    const nextAttempt = attemptFixture({
      fencingToken: 2,
      lastHeartbeatAt: 1_500,
      leaseExpiresAt: 3_500,
      managerIncarnationId: 'manager-2',
      revision: 1,
      updatedAt: 1_500,
    });
    const command: RunStoreAcquireAttemptCommand = {
      change: { attempt: nextAttempt, node, run },
      evidence: { handoffId: 'handoff-1', kind: 'handoff' },
      expected: {
        attempt: {
          ...attemptExpectation(attempt),
          handoff: {
            handoffId: 'handoff-1',
            key: handoff.handoff.key,
            kind: 'named',
          },
        },
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      idempotency: idempotency('acquire_attempt', run.id, attempt.id),
      kind: 'acquire_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      successorManagerIncarnationId: 'manager-2',
    };
    store.failAfterNextStage('handoff_consumption');

    await expect(
      store.transaction(async (transaction) => transaction.commit(command)),
    ).rejects.toThrow('after handoff_consumption');
    await store.transaction(async (transaction) => {
      await expect(transaction.getAttempt(attempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { fencingToken: 1, managerIncarnationId: 'manager-1' },
      });
      await expect(transaction.getHandoff(handoff.handoff.key)).resolves.toMatchObject({
        kind: 'found',
        value: { consumption: null },
      });
    });
  });

  it('rolls back unowned, incumbent, and acquisition command-family stages', async () => {
    const incumbent = incumbentCase('direct_success');
    const incumbentStore = new LogicalRunStoreFake(1_500);
    incumbentStore.seed({
      attempts: [incumbent.attempt],
      nodes: [incumbent.node],
      runs: [incumbent.run],
    });
    incumbentStore.failAfterNextStage('events');
    await expect(
      incumbentStore.transaction(async (transaction) => transaction.commit(incumbent.command)),
    ).rejects.toThrow('after events');
    await incumbentStore.transaction(async (transaction) => {
      await expect(transaction.getAttempt(incumbent.attempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { revision: incumbent.attempt.revision, status: incumbent.attempt.status },
      });
    });

    const run = runFixture();
    const newNode = nodeFixture({
      activationId: 'rollback-activation',
      createdAt: 1_500,
      id: 'rollback-node',
      updatedAt: 1_500,
    });
    const unowned: RunStoreUnownedTransitionCommand = {
      expected: {
        absentAttemptIds: [],
        absentNodes: [
          {
            activationId: newNode.activationId,
            activationKey: newNode.activationKey,
            forkScopeKey: newNode.forkScopeKey,
            nodeInstanceId: newNode.id,
            runId: newNode.runId,
          },
        ],
        absentOutputIds: [],
        attempts: [],
        nodes: [],
        run: runExpectation(run),
      },
      idempotency: null,
      kind: 'apply_unowned_transition',
      operation: 'activate_nodes',
      transition: transitionFixture({
        nodes: [newNode],
        run: runFixture({ revision: 1, updatedAt: 1_500 }),
      }),
    };
    const unownedStore = new LogicalRunStoreFake(1_500);
    unownedStore.seed({ runs: [run] });
    unownedStore.failAfterNextStage('nodes');
    await expect(
      unownedStore.transaction(async (transaction) => transaction.commit(unowned)),
    ).rejects.toThrow('after nodes');
    await unownedStore.transaction(async (transaction) => {
      await expect(transaction.getNode(newNode.id)).resolves.toEqual({ kind: 'not_found' });
    });

    const takeoverNode = executingNodeFixture('executing', { revision: 1 });
    const takeoverAttempt = attemptFixture();
    const acquisition: RunStoreAcquireAttemptCommand = {
      change: {
        attempt: attemptFixture({
          fencingToken: 2,
          lastHeartbeatAt: 3_000,
          leaseExpiresAt: 5_000,
          managerIncarnationId: 'manager-2',
          revision: 1,
          updatedAt: 3_000,
        }),
        node: takeoverNode,
        run,
      },
      evidence: { kind: 'lease_expired' },
      expected: {
        attempt: attemptExpectation(takeoverAttempt),
        node: nodeExpectation(takeoverNode),
        run: runExpectation(run),
      },
      idempotency: idempotency('acquire_attempt', run.id, takeoverAttempt.id),
      kind: 'acquire_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      successorManagerIncarnationId: 'manager-2',
    };
    const acquisitionStore = new LogicalRunStoreFake(3_000);
    acquisitionStore.seed({
      attempts: [takeoverAttempt],
      nodes: [takeoverNode],
      runs: [run],
    });
    acquisitionStore.failAfterNextStage('attempts');
    await expect(
      acquisitionStore.transaction(async (transaction) => transaction.commit(acquisition)),
    ).rejects.toThrow('after attempts');
    await acquisitionStore.transaction(async (transaction) => {
      await expect(transaction.getAttempt(takeoverAttempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { fencingToken: 1, managerIncarnationId: 'manager-1', revision: 0 },
      });
    });
  });

  it('retains sequential fence-1 and fence-2 handoff consumption history', async () => {
    const store = new LogicalRunStoreFake(1_500);
    const run = runFixture();
    const node = executingNodeFixture('executing', { revision: 1 });
    const firstAttempt = attemptFixture();
    const firstHandoff: AttemptHandoffState = {
      consumption: null,
      handoff: {
        activationId: node.activationId,
        createdAt: 1_400,
        expectedAttemptRevision: 0,
        id: 'handoff-1',
        incumbentManagerIncarnationId: 'manager-1',
        key: { attemptId: firstAttempt.id, incumbentFencingToken: 1 },
        nodeInstanceId: node.id,
        reason: 'manager_shutdown',
        runId: run.id,
      },
    };
    store.seed({
      attempts: [firstAttempt],
      handoffs: [firstHandoff],
      nodes: [node],
      runs: [run],
    });
    const secondAttempt = attemptFixture({
      fencingToken: 2,
      lastHeartbeatAt: 1_500,
      leaseExpiresAt: 3_500,
      managerIncarnationId: 'manager-2',
      revision: 1,
      updatedAt: 1_500,
    });
    const firstAcquire: RunStoreAcquireAttemptCommand = {
      change: { attempt: secondAttempt, node, run },
      evidence: { handoffId: 'handoff-1', kind: 'handoff' },
      expected: {
        attempt: {
          ...attemptExpectation(firstAttempt),
          handoff: {
            handoffId: 'handoff-1',
            key: firstHandoff.handoff.key,
            kind: 'named',
          },
        },
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      idempotency: idempotency('acquire_attempt', run.id, firstAttempt.id, 'acquire-1'),
      kind: 'acquire_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      successorManagerIncarnationId: 'manager-2',
    };
    await store.transaction(async (transaction) => transaction.commit(firstAcquire));
    const writeSecond: RunStoreWriteHandoffCommand = {
      authority: {
        ...authority(0, 1, 1),
        fencingToken: 2,
        managerIncarnationId: 'manager-2',
      },
      expected: {
        attempt: attemptExpectation(secondAttempt),
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      handoffId: 'handoff-2',
      idempotency: idempotency('write_handoff', run.id, secondAttempt.id, 'handoff-2'),
      kind: 'write_handoff',
      reason: 'manager_shutdown',
    };
    await store.transaction(async (transaction) => transaction.commit(writeSecond));
    const thirdAttempt = attemptFixture({
      fencingToken: 3,
      lastHeartbeatAt: 1_500,
      leaseExpiresAt: 3_500,
      managerIncarnationId: 'manager-3',
      revision: 2,
      updatedAt: 1_500,
    });
    const secondAcquire: RunStoreAcquireAttemptCommand = {
      change: { attempt: thirdAttempt, node, run },
      evidence: { handoffId: 'handoff-2', kind: 'handoff' },
      expected: {
        attempt: {
          ...attemptExpectation(secondAttempt),
          handoff: {
            handoffId: 'handoff-2',
            key: { attemptId: secondAttempt.id, incumbentFencingToken: 2 },
            kind: 'named',
          },
        },
        node: nodeExpectation(node),
        run: runExpectation(run),
      },
      idempotency: idempotency('acquire_attempt', run.id, secondAttempt.id, 'acquire-2'),
      kind: 'acquire_attempt',
      leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
      successorManagerIncarnationId: 'manager-3',
    };
    await store.transaction(async (transaction) => transaction.commit(secondAcquire));

    await store.transaction(async (transaction) => {
      await expect(transaction.getHandoff(firstHandoff.handoff.key)).resolves.toMatchObject({
        kind: 'found',
        value: { consumption: { successorFencingToken: 2 } },
      });
      await expect(
        transaction.getHandoff({
          attemptId: secondAttempt.id,
          incumbentFencingToken: 2,
        }),
      ).resolves.toMatchObject({
        kind: 'found',
        value: { consumption: { successorFencingToken: 3 } },
      });
      await expect(transaction.getAttempt(thirdAttempt.id)).resolves.toMatchObject({
        kind: 'found',
        value: { fencingToken: 3, managerIncarnationId: 'manager-3' },
      });
    });
  });

  it.each([
    ['claimed', 'executing', 'claimed', 'executing', 0, 1],
    ['start_committed', 'executing', 'unknown', 'unknown', 1, 2],
    ['unknown', 'unknown', 'unknown', 'unknown', 0, 1],
    ['reconciling', 'unknown', 'unknown', 'unknown', 0, 1],
  ] as const)(
    'acquires expired %s/%s ownership into %s/%s',
    async (fromAttempt, fromNode, toAttempt, toNode, revisionDelta, nodeRevision) => {
      const store = new LogicalRunStoreFake(3_000);
      const run = runFixture();
      const node = executingNodeFixture(fromNode, { revision: 1 });
      const attempt = attemptFixture({ status: fromAttempt });
      store.seed({ attempts: [attempt], nodes: [node], runs: [run] });
      const nextRun = runFixture({
        revision: revisionDelta,
        updatedAt: revisionDelta === 0 ? 1_000 : 3_000,
      });
      const nextNode = executingNodeFixture(toNode, {
        revision: nodeRevision,
        updatedAt: nodeRevision === 1 ? 1_000 : 3_000,
      });
      const nextAttempt = attemptFixture({
        fault:
          toAttempt === 'unknown'
            ? { code: 'UNKNOWN_OUTCOME', message: 'Outcome is unknown.' }
            : null,
        fencingToken: 2,
        lastHeartbeatAt: 3_000,
        leaseExpiresAt: 5_000,
        managerIncarnationId: 'manager-2',
        revision: 1,
        status: toAttempt,
        updatedAt: 3_000,
      });
      const command: RunStoreAcquireAttemptCommand = {
        change: { attempt: nextAttempt, node: nextNode, run: nextRun },
        evidence: { kind: 'lease_expired' },
        expected: {
          attempt: attemptExpectation(attempt),
          node: nodeExpectation(node),
          run: runExpectation(run),
        },
        idempotency: idempotency('acquire_attempt', run.id, attempt.id),
        kind: 'acquire_attempt',
        leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
        successorManagerIncarnationId: 'manager-2',
      };

      await expect(
        store.transaction(async (transaction) => transaction.commit(command)),
      ).resolves.toMatchObject({
        kind: 'committed',
        takeover: {
          attempt: { fencingToken: 2, status: toAttempt },
          evidence: 'lease_expired',
          node: { status: toNode },
        },
      });
    },
  );

  it.each([
    [
      'Run cancellation request',
      (command: RunStoreAcquireAttemptCommand): RunStoreAcquireAttemptCommand => ({
        ...command,
        change: {
          ...command.change,
          run: { ...command.change.run, cancellationRequestedAt: 2_500 },
        },
      }),
    ],
    [
      'Run terminal fault',
      (command: RunStoreAcquireAttemptCommand): RunStoreAcquireAttemptCommand => ({
        ...command,
        change: {
          ...command.change,
          run: {
            ...command.change.run,
            terminalFault: { code: 'CANCELLED', message: 'Unrelated terminal fault.' },
          },
        },
      }),
    ],
    [
      'node active Attempt',
      (command: RunStoreAcquireAttemptCommand): RunStoreAcquireAttemptCommand => ({
        ...command,
        change: {
          ...command.change,
          node: { ...command.change.node, activeAttemptId: null },
        },
      }),
    ],
    [
      'node retry availability',
      (command: RunStoreAcquireAttemptCommand): RunStoreAcquireAttemptCommand => ({
        ...command,
        change: {
          ...command.change,
          node: { ...command.change.node, retryAvailableAt: 4_000 },
        },
      }),
    ],
    [
      'node terminal fault',
      (command: RunStoreAcquireAttemptCommand): RunStoreAcquireAttemptCommand => ({
        ...command,
        change: {
          ...command.change,
          node: {
            ...command.change.node,
            terminalFault: { code: 'CANCELLED', message: 'Unrelated terminal fault.' },
          },
        },
      }),
    ],
  ] as const)(
    'rejects start_committed/executing takeover mutation of unrelated %s',
    async (_field, mutate) => {
      const takeover = acquisitionCase('start_committed');
      const store = new LogicalRunStoreFake(3_000);
      store.seed({
        attempts: [takeover.attempt],
        nodes: [takeover.node],
        runs: [takeover.run],
      });

      await expect(
        store.transaction(async (transaction) => transaction.commit(mutate(takeover.command))),
      ).resolves.toMatchObject({ kind: 'invalid_input' });
      await store.transaction(async (transaction) => {
        await expect(transaction.getRun(takeover.run.id)).resolves.toEqual({
          kind: 'found',
          value: takeover.run,
        });
        await expect(transaction.getNode(takeover.node.id)).resolves.toEqual({
          kind: 'found',
          value: takeover.node,
        });
        await expect(transaction.getAttempt(takeover.attempt.id)).resolves.toEqual({
          kind: 'found',
          value: takeover.attempt,
        });
      });
    },
  );

  it('paginates Runs and events with fixed high-watermarks and strict seek', async () => {
    const store = new LogicalRunStoreFake(1_000);
    await store.transaction(async (transaction) => transaction.commit(createCommand('run-a', 'a')));
    await store.transaction(async (transaction) => transaction.commit(createCommand('run-b', 'b')));
    const first = await store.listRuns({
      limit: 1,
      planId: null,
      scan: { kind: 'start' },
      statuses: [],
    });
    expect(first).toMatchObject({
      kind: 'page',
      page: { items: [{ id: 'run-a' }], next: { lastRunId: 'run-a' } },
    });
    if (first.kind !== 'page' || first.page.next === null) {
      throw new Error('Expected Run continuation.');
    }
    await expect(
      store.listRuns({
        limit: 1,
        planId: null,
        scan: { cursor: first.page.next, kind: 'continue' },
        statuses: [],
      }),
    ).resolves.toMatchObject({
      kind: 'page',
      page: { items: [{ id: 'run-b' }], next: null },
    });
  });

  it('retains an event scan ceiling across exclusive continuation pages', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const base = createCommand();
    const firstIntent = base.eventIntents[0];
    if (firstIntent === undefined) throw new Error('Expected event intent.');
    const command: RunStoreCreateRunCommand = {
      ...base,
      eventIntents: [firstIntent, firstIntent],
    };
    await store.transaction(async (transaction) => transaction.commit(command));
    const first = await store.readEvents({
      limit: 1,
      runId: 'run-1',
      scan: { after: { runId: 'run-1', sequence: 0 }, kind: 'start' },
    });
    expect(first).toMatchObject({
      kind: 'page',
      page: {
        highWatermark: { sequence: 2 },
        items: [{ sequence: 1 }],
        next: { afterSequence: 1, highWatermarkSequence: 2 },
      },
    });
    if (first.kind !== 'page' || first.page.next === null) {
      throw new Error('Expected event continuation.');
    }
    await expect(
      store.readEvents({
        limit: 1,
        runId: 'run-1',
        scan: { cursor: first.page.next, kind: 'continue' },
      }),
    ).resolves.toMatchObject({
      kind: 'page',
      page: {
        highWatermark: { sequence: 2 },
        items: [{ sequence: 2 }],
        next: null,
      },
    });
  });

  it('paginates nodes, Attempts, and outputs by UTF-8 id with filter-bound cursors', async () => {
    const store = new LogicalRunStoreFake(1_000);
    const nodeA = nodeFixture({ id: 'a-node' });
    const nodeB = nodeFixture({ id: 'b-node' });
    const attemptA = attemptFixture({ id: 'a-attempt', nodeInstanceId: nodeA.id });
    const attemptB = attemptFixture({ id: 'b-attempt', nodeInstanceId: nodeB.id });
    const outputA = outputFixture({ id: 'a-output', name: 'alpha' });
    const outputB = outputFixture({ id: 'b-output', name: 'beta' });
    store.seed({
      attempts: [attemptB, attemptA],
      nodes: [nodeB, nodeA],
      outputs: [outputB, outputA],
      runs: [runFixture()],
    });

    await store.transaction(async (transaction) => {
      const nodes = await transaction.listNodes({
        cursor: null,
        forkScopeKey: null,
        limit: 1,
        nodeKeys: [],
        runId: 'run-1',
        statuses: [],
      });
      expect(nodes).toMatchObject({
        kind: 'page',
        page: { items: [{ id: 'a-node' }], next: { lastNodeInstanceId: 'a-node' } },
      });
      const attempts = await transaction.listAttempts({
        cursor: null,
        limit: 1,
        managerIncarnationId: null,
        nodeInstanceId: null,
        runId: 'run-1',
        statuses: [],
      });
      expect(attempts).toMatchObject({
        kind: 'page',
        page: { items: [{ id: 'a-attempt' }], next: { lastAttemptId: 'a-attempt' } },
      });
      const outputs = await transaction.listOutputs({
        activationId: null,
        attemptId: null,
        cursor: null,
        limit: 1,
        names: [],
        nodeInstanceId: null,
        runId: 'run-1',
      });
      expect(outputs).toMatchObject({
        kind: 'page',
        page: { items: [{ id: 'a-output' }], next: { lastOutputId: 'a-output' } },
      });
    });
  });

  it.each([0, 101, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects page limit %s across Store scans',
    async (limit) => {
      const store = new LogicalRunStoreFake(1_000);
      await expect(
        store.listRuns({
          limit,
          planId: null,
          scan: { kind: 'start' },
          statuses: [],
        }),
      ).resolves.toMatchObject({ kind: 'invalid_input' });
      await expect(
        store.readEvents({
          limit,
          runId: 'run-1',
          scan: { after: { runId: 'run-1', sequence: 0 }, kind: 'start' },
        }),
      ).resolves.toMatchObject({ kind: 'invalid_input' });
    },
  );

  it('rejects duplicate/noncanonical filters and continuation mismatches', async () => {
    const store = new LogicalRunStoreFake(1_000);
    await expect(
      store.listRuns({
        limit: 10,
        planId: null,
        scan: { kind: 'start' },
        statuses: ['failed', 'running'],
      }),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
    await expect(
      store.discover({
        kinds: ['expired_attempt', 'expired_attempt'],
        limit: 10,
        renewal: null,
        scan: { kind: 'start' },
      }),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
    await expect(
      store.readEvents({
        limit: 10,
        runId: 'run-1',
        scan: { after: { runId: 'other', sequence: 0 }, kind: 'start' },
      }),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('discovers all six logical candidate shapes without reserving work', async () => {
    const store = new LogicalRunStoreFake(3_000);
    const cancelling = runFixture({
      cancellationRequestedAt: 2_000,
      id: 'cancel',
      status: 'cancelling',
      updatedAt: 2_000,
    });
    const ready = nodeFixture({ id: 'ready', runId: 'run-1' });
    const executing = executingNodeFixture('executing', { id: 'node-1', revision: 1 });
    const expired = attemptFixture();
    const handoffNode = executingNodeFixture('executing', {
      activeAttemptId: 'attempt-handoff',
      activationId: 'activation-handoff',
      id: 'node-handoff',
      revision: 1,
    });
    const handoffAttempt = attemptFixture({
      id: 'attempt-handoff',
      nodeInstanceId: handoffNode.id,
    });
    const renewableNode = executingNodeFixture('executing', {
      activeAttemptId: 'attempt-renewable',
      activationId: 'activation-renewable',
      id: 'node-renewable',
      revision: 1,
    });
    const renewableAttempt = attemptFixture({
      id: 'attempt-renewable',
      lastHeartbeatAt: 1_000,
      leaseExpiresAt: 4_000,
      nodeInstanceId: renewableNode.id,
    });
    store.seed({
      attempts: [expired, handoffAttempt, renewableAttempt],
      handoffs: [
        {
          consumption: null,
          handoff: {
            activationId: handoffNode.activationId,
            createdAt: 2_000,
            expectedAttemptRevision: handoffAttempt.revision,
            id: 'handoff-discovery',
            incumbentManagerIncarnationId: handoffAttempt.managerIncarnationId,
            key: {
              attemptId: handoffAttempt.id,
              incumbentFencingToken: handoffAttempt.fencingToken,
            },
            nodeInstanceId: handoffNode.id,
            reason: 'manager_shutdown',
            runId: handoffAttempt.runId,
          },
        },
      ],
      nodes: [ready, executing, handoffNode, renewableNode],
      runs: [runFixture(), cancelling],
    });

    const result = await store.discover({
      kinds: [
        'handoff_attempt',
        'expired_attempt',
        'renewable_attempt',
        'claimable_node',
        'cancellation_run',
        'progressable_run',
      ],
      limit: 100,
      renewal: {
        leasePolicy: { heartbeatIntervalMs: 500, leaseDurationMs: 2_000 },
        managerIncarnationId: 'manager-1',
      },
      scan: { kind: 'start' },
    });
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') throw new Error('Expected discovery page.');
    expect(result.page.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        'expired_attempt',
        'handoff_attempt',
        'renewable_attempt',
        'claimable_node',
        'cancellation_run',
        'progressable_run',
      ]),
    );
  });

  it('keeps A3 renewal and non-renew command shapes statically disjoint', () => {
    type RenewalHasPolicy = 'leasePolicy' extends keyof RunStoreRenewLeaseTransitionCommand
      ? true
      : false;
    type NonRenewForbidsPolicy =
      RunStoreNonRenewIncumbentTransitionCommand['leasePolicy'] extends undefined ? true : false;
    type RenewalHasNullIdempotency = RunStoreRenewLeaseTransitionCommand['idempotency'] extends null
      ? true
      : false;
    type NonRenewRequiresIdempotency =
      null extends RunStoreNonRenewIncumbentTransitionCommand['idempotency'] ? false : true;
    type ClosedUnion = RunStoreIncumbentTransitionCommand extends
      | RunStoreRenewLeaseTransitionCommand
      | RunStoreNonRenewIncumbentTransitionCommand
      ? true
      : false;

    expectTypeOf<RenewalHasPolicy>().toEqualTypeOf<true>();
    expectTypeOf<NonRenewForbidsPolicy>().toEqualTypeOf<true>();
    expectTypeOf<RenewalHasNullIdempotency>().toEqualTypeOf<true>();
    expectTypeOf<NonRenewRequiresIdempotency>().toEqualTypeOf<true>();
    expectTypeOf<ClosedUnion>().toEqualTypeOf<true>();
  });
});
