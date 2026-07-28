import { describe, expect, it } from 'vitest';

import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  progressionOperationCase,
  progressionTransactionNow,
} from '../support/progression-store-fixtures.js';
import { attemptFixture, nodeFixture, outputFixture } from '../support/store-fixtures.js';

describe('progression Store transition rollback', () => {
  it.each(['run', 'nodes', 'attempts', 'outputs', 'events', 'idempotency'] as const)(
    'rolls back a %s staging failure',
    async (stage) => {
      const fixture = progressionOperationCase('consensus_verdict');
      const node = nodeFixture({
        activationId: 'created-activation',
        createdAt: progressionTransactionNow,
        id: 'created-node',
        nodeKey: 'created-node',
        updatedAt: progressionTransactionNow,
      });
      const attempt = attemptFixture({
        createdAt: progressionTransactionNow,
        id: 'created-attempt',
        lastHeartbeatAt: progressionTransactionNow,
        leaseExpiresAt: 3_000,
        nodeInstanceId: node.id,
        updatedAt: progressionTransactionNow,
      });
      const output = outputFixture({
        createdAt: progressionTransactionNow,
        id: 'created-output',
      });
      const expected = fixture.command.expected;
      if (expected.kind !== 'transition') throw new TypeError('Expected transition fixture.');
      const command = {
        ...fixture.command,
        expected: {
          kind: 'transition',
          value: {
            ...expected.value,
            absentAttemptIds: [attempt.id],
            absentNodes: [
              {
                activationId: node.activationId,
                activationKey: node.activationKey,
                forkScopeKey: node.forkScopeKey,
                nodeInstanceId: node.id,
                runId: node.runId,
              },
            ],
            absentOutputIds: [output.id],
          },
        },
        transition: {
          ...fixture.command.transition,
          attempts: [...fixture.command.transition.attempts, attempt],
          eventIntents: [
            {
              correlation: { kind: 'run' },
              kind: 'output.recorded',
              payload: { name: output.name, outputId: output.id, payloadKind: 'json' },
              runId: fixture.run.id,
            },
          ],
          nodes: [...fixture.command.transition.nodes, node],
          outputs: [output],
        },
      } as const;
      const store = new LogicalRunStoreFake(progressionTransactionNow);
      store.seed({ nodes: fixture.nodes, runs: [fixture.run] });
      store.failAfterNextStage(stage);

      await expect(store.transaction((transaction) => transaction.commit(command))).rejects.toThrow(
        `Injected logical provider failure after ${stage}.`,
      );
      await expect(store.getRun(fixture.run.id)).resolves.toEqual({
        kind: 'found',
        value: fixture.run,
      });
      await expect(
        store.transaction((transaction) => transaction.commit(command)),
      ).resolves.toMatchObject({ kind: 'committed' });
    },
  );
});
