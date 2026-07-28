import { describe, expect, it } from 'vitest';

import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  progressionOperationCase,
  progressionTerminalTaskCase,
  progressionTransactionNow,
} from '../support/progression-store-fixtures.js';
import {
  attemptFixture,
  configurationDigest,
  executorPin,
  nodeFixture,
} from '../support/store-fixtures.js';

describe('progression Store replay', () => {
  it('replays an exact task command under a new key after terminal authority is gone', async () => {
    const fixture = progressionTerminalTaskCase();
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({
      attempts: [fixture.attempt],
      nodes: [fixture.node],
      runs: [fixture.run],
    });
    await expect(
      store.transaction((transaction) => transaction.commit(fixture.command)),
    ).resolves.toMatchObject({ kind: 'committed' });

    await expect(
      store.transaction((transaction) =>
        transaction.commit({
          ...fixture.command,
          idempotency: {
            ...fixture.command.idempotency,
            identity: {
              ...fixture.command.idempotency.identity,
              key: 'terminal-task-new-external-key',
            },
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'replayed',
      record: { result: fixture.command.idempotency.result },
    });
  });

  it('rejects a false terminal event on a waiting progression transition', async () => {
    const fixture = progressionOperationCase('consensus_verdict');
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ nodes: fixture.nodes, runs: [fixture.run] });

    await expect(
      store.transaction((transaction) =>
        transaction.commit({
          ...fixture.command,
          transition: {
            ...fixture.command.transition,
            eventIntents: [
              {
                correlation: { kind: 'run' },
                kind: 'run.terminalized',
                payload: {
                  fault: null,
                  nodeKey: 'selector',
                  outcome: 'done',
                  status: 'succeeded',
                },
                runId: fixture.run.id,
              },
            ],
          },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
    await expect(store.getRun(fixture.run.id)).resolves.toEqual({
      kind: 'found',
      value: fixture.run,
    });
  });

  it.each(['task_outcome', 'consensus_verdict', 'human_gate_resolution'] as const)(
    'commits and canonically replays the %s trigger family',
    async (operation) => {
      const fixture = progressionOperationCase(operation);
      const store = new LogicalRunStoreFake(progressionTransactionNow);
      store.seed({ attempts: fixture.attempts, nodes: fixture.nodes, runs: [fixture.run] });

      await expect(
        store.transaction((transaction) => transaction.commit(fixture.command)),
      ).resolves.toMatchObject({ kind: 'committed' });
      await expect(
        store.transaction((transaction) => transaction.commit(fixture.command)),
      ).resolves.toMatchObject({
        kind: 'replayed',
        record: { result: fixture.command.idempotency.result },
      });
    },
  );

  it('rejects changed host data under the same external key before CAS', async () => {
    const fixture = progressionOperationCase('human_gate_resolution');
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ nodes: fixture.nodes, runs: [fixture.run] });
    await store.transaction((transaction) => transaction.commit(fixture.command));

    await expect(
      store.transaction((transaction) =>
        transaction.commit({
          ...fixture.command,
          idempotency: {
            ...fixture.command.idempotency,
            request: { answer: 'changed', operation: 'human_gate_resolution' },
          },
        }),
      ),
    ).resolves.toMatchObject({
      conflict: { code: 'IDEMPOTENCY_CONFLICT' },
      kind: 'conflict',
    });
  });

  it('returns an exact new-key semantic replay without creating another idempotency record', async () => {
    const fixture = progressionOperationCase('human_gate_resolution');
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ nodes: fixture.nodes, runs: [fixture.run] });
    await store.transaction((transaction) => transaction.commit(fixture.command));
    const newKeyCommand = {
      ...fixture.command,
      idempotency: {
        ...fixture.command.idempotency,
        identity: { ...fixture.command.idempotency.identity, key: 'new-external-key' },
      },
    } as const;

    await expect(
      store.transaction((transaction) => transaction.commit(newKeyCommand)),
    ).resolves.toMatchObject({
      kind: 'replayed',
      record: { result: fixture.command.idempotency.result },
    });

    const receipts = newKeyCommand.transition.run.progression.commandReceipts;
    const progression = newKeyCommand.transition.run.progression;
    if (progression.phase !== 'active') throw new TypeError('Expected active progression.');
    const last = receipts.at(-1);
    if (last === undefined) throw new TypeError('Expected durable command receipt.');
    await expect(
      store.transaction((transaction) =>
        transaction.commit({
          ...newKeyCommand,
          idempotency: {
            ...newKeyCommand.idempotency,
            request: { answer: 'changed', operation: 'human_gate_resolution' },
          },
          transition: {
            ...newKeyCommand.transition,
            run: {
              ...newKeyCommand.transition.run,
              progression: {
                ...progression,
                commandReceipts: [
                  ...receipts.slice(0, -1),
                  {
                    ...last,
                    hostAttachment: {
                      answerOutput: { kind: 'json', value: 'changed' },
                      kind: 'gate_answer_output',
                    },
                  },
                ],
              },
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects unrelated live incumbent authority without writing', async () => {
    const fixture = progressionOperationCase('task_outcome');
    const unrelatedAttempt = attemptFixture({
      id: 'unrelated-attempt',
      nodeInstanceId: 'unrelated-node',
    });
    const unrelatedNode = nodeFixture({
      activationId: 'unrelated-activation',
      activeAttemptId: unrelatedAttempt.id,
      id: 'unrelated-node',
      nodeKey: 'unrelated',
      status: 'executing',
    });
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({
      attempts: [...fixture.attempts, unrelatedAttempt],
      nodes: [...fixture.nodes, unrelatedNode],
      runs: [fixture.run],
    });

    await expect(
      store.transaction((transaction) =>
        transaction.commit({
          ...fixture.command,
          idempotency: {
            ...fixture.command.idempotency,
            identity: {
              ...fixture.command.idempotency.identity,
              subjectId: unrelatedAttempt.id,
            },
          },
          trigger: {
            authority: {
              attemptId: unrelatedAttempt.id,
              executorConfigurationDigest: configurationDigest,
              executorContractPin: executorPin,
              expectedAttemptRevision: unrelatedAttempt.revision,
              expectedNodeRevision: unrelatedNode.revision,
              expectedRunRevision: fixture.run.revision,
              fencingToken: unrelatedAttempt.fencingToken,
              managerIncarnationId: unrelatedAttempt.managerIncarnationId,
            },
            kind: 'incumbent_attempt',
          },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_input' });
    await expect(store.getRun(fixture.run.id)).resolves.toEqual({
      kind: 'found',
      value: fixture.run,
    });
  });
});
