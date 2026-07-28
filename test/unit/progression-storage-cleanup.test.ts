import { describe, expect, it } from 'vitest';

import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  progressionCleanupCase,
  progressionTransactionNow,
} from '../support/progression-store-fixtures.js';

describe('progression Store cleanup and rollback', () => {
  it('rejects republishing the already durable terminal event during cleanup', async () => {
    const fixture = progressionCleanupCase();
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ attempts: [fixture.attempt], nodes: fixture.nodes, runs: [fixture.run] });

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
                  nodeKey: 'terminal',
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
  });

  it('settles authority without changing Run revision, time, progression, outputs or events', async () => {
    const fixture = progressionCleanupCase();
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ attempts: [fixture.attempt], nodes: fixture.nodes, runs: [fixture.run] });

    const result = await store.transaction((transaction) => transaction.commit(fixture.command));
    expect(result).toMatchObject({ cursor: { sequence: 0 }, kind: 'committed' });
    await expect(store.getRun(fixture.run.id)).resolves.toEqual({
      kind: 'found',
      value: fixture.run,
    });
  });

  it.each(['run', 'nodes', 'attempts', 'outputs', 'events', 'idempotency'] as const)(
    'rolls back after the %s staging boundary',
    async (stage) => {
      const fixture = progressionCleanupCase();
      const store = new LogicalRunStoreFake(progressionTransactionNow);
      store.seed({ attempts: [fixture.attempt], nodes: fixture.nodes, runs: [fixture.run] });
      store.failAfterNextStage(stage);

      await expect(
        store.transaction((transaction) => transaction.commit(fixture.command)),
      ).rejects.toThrow(`Injected logical provider failure after ${stage}.`);
      await expect(store.getRun(fixture.run.id)).resolves.toEqual({
        kind: 'found',
        value: fixture.run,
      });
      await expect(
        store.transaction((transaction) => transaction.commit(fixture.command)),
      ).resolves.toMatchObject({ kind: 'committed' });
    },
  );
});
