import { describe, expect, it } from 'vitest';

import { createRun } from '../../src/domain/index.js';
import type { RunStoreProgressionTransitionCommand } from '../../src/storage/index.js';
import { LogicalRunStoreFake } from '../support/logical-run-store-fake.js';
import {
  progressionCleanupCase,
  progressionOperationCase,
  progressionTransactionNow,
} from '../support/progression-store-fixtures.js';
import { attemptFixture, nodeFixture, outputFixture } from '../support/store-fixtures.js';

describe('progression Store CAS and concurrency', () => {
  it('allows only one sibling transition against the same Run revision', async () => {
    const first = progressionOperationCase('consensus_verdict');
    const second = progressionOperationCase('human_gate_resolution');
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ nodes: [...first.nodes, ...second.nodes], runs: [first.run] });

    const results = await Promise.all([
      store.transaction((transaction) => transaction.commit(first.command)),
      store.transaction((transaction) => transaction.commit(second.command)),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['committed', 'conflict']);
  });

  it('allows only one competing terminal selection against the same Run revision', async () => {
    const first = progressionOperationCase('consensus_verdict');
    const second = progressionOperationCase('human_gate_resolution');
    const terminalize = (
      fixture: ReturnType<typeof progressionOperationCase>,
      outcome: string,
      status: 'succeeded' | 'cancelled',
    ): RunStoreProgressionTransitionCommand => {
      const progression = fixture.command.transition.run.progression;
      if (progression.phase !== 'active') throw new TypeError('Expected active progression.');
      const priorReceipt = progression.commandReceipts.at(-1);
      if (priorReceipt === undefined) throw new TypeError('Expected command receipt.');
      const result = {
        ...fixture.command.idempotency.result,
        outcome: {
          kind: 'terminal',
          terminal: { fault: null, nodeKey: 'terminal', outcome, status },
        },
      } as const;
      return {
        ...fixture.command,
        idempotency: { ...fixture.command.idempotency, result },
        transition: {
          ...fixture.command.transition,
          eventIntents: [
            {
              correlation: { kind: 'run' },
              kind: 'run.terminalized',
              payload: {
                fault: null,
                nodeKey: 'terminal',
                outcome,
                status,
              },
              runId: fixture.run.id,
            },
          ],
          run: createRun({
            ...fixture.command.transition.run,
            progression: {
              ...progression,
              commandReceipts: [
                ...progression.commandReceipts.slice(0, -1),
                { ...priorReceipt, result },
              ],
              nodes: [{ nodeKey: 'terminal', outcome, state: 'terminal' }],
              phase: 'terminal',
              terminal: { nodeKey: 'terminal', outcome },
            },
            status,
            terminalAt: progressionTransactionNow,
          }),
        },
      };
    };
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ nodes: [...first.nodes, ...second.nodes], runs: [first.run] });

    const results = await Promise.all([
      store.transaction((transaction) =>
        transaction.commit(terminalize(first, 'accepted', 'succeeded')),
      ),
      store.transaction((transaction) =>
        transaction.commit(terminalize(second, 'cancelled', 'cancelled')),
      ),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['committed', 'conflict']);
  });

  it.each([
    ['run', 'REVISION_CONFLICT'],
    ['node', 'REVISION_CONFLICT'],
    ['attempt', 'STALE_FENCE'],
  ] as const)('rejects a stale cleanup %s revision axis', async (axis, code) => {
    const fixture = progressionCleanupCase();
    const expected = fixture.command.expected;
    if (expected.kind !== 'transition') throw new TypeError('Expected transition fixture.');
    const command: RunStoreProgressionTransitionCommand = {
      ...fixture.command,
      expected: {
        kind: 'transition',
        value: {
          ...expected.value,
          attempts:
            axis === 'attempt'
              ? [{ ...expected.value.attempts[0]!, revision: 1 }]
              : expected.value.attempts,
          nodes:
            axis === 'node' ? [{ ...expected.value.nodes[0]!, revision: 1 }] : expected.value.nodes,
          run: axis === 'run' ? { ...expected.value.run, revision: 1 } : expected.value.run,
        },
      },
    };
    const store = new LogicalRunStoreFake(progressionTransactionNow);
    store.seed({ attempts: [fixture.attempt], nodes: [fixture.node], runs: [fixture.run] });

    await expect(
      store.transaction((transaction) => transaction.commit(command)),
    ).resolves.toMatchObject({ conflict: { code }, kind: 'conflict' });
  });

  it.each(['node', 'attempt', 'output'] as const)(
    'rejects a progression %s absence collision',
    async (axis) => {
      const fixture = progressionOperationCase('consensus_verdict');
      const expected = fixture.command.expected;
      if (expected.kind !== 'transition') throw new TypeError('Expected transition fixture.');
      const newNode = nodeFixture({
        activationId: 'new-activation',
        createdAt: progressionTransactionNow,
        id: 'new-node',
        nodeKey: 'new-node',
        updatedAt: progressionTransactionNow,
      });
      const newAttempt = attemptFixture({
        createdAt: progressionTransactionNow,
        id: 'new-attempt',
        lastHeartbeatAt: progressionTransactionNow,
        leaseExpiresAt: 3_000,
        nodeInstanceId: fixture.nodes[0]!.id,
        updatedAt: progressionTransactionNow,
      });
      const newOutput = outputFixture({
        createdAt: progressionTransactionNow,
        id: 'new-output',
      });
      const command: RunStoreProgressionTransitionCommand = {
        ...fixture.command,
        expected: {
          kind: 'transition',
          value: {
            ...expected.value,
            absentAttemptIds: axis === 'attempt' ? [newAttempt.id] : [],
            absentNodes:
              axis === 'node'
                ? [
                    {
                      activationId: newNode.activationId,
                      activationKey: newNode.activationKey,
                      forkScopeKey: newNode.forkScopeKey,
                      nodeInstanceId: newNode.id,
                      runId: newNode.runId,
                    },
                  ]
                : [],
            absentOutputIds: axis === 'output' ? [newOutput.id] : [],
          },
        },
        transition: {
          ...fixture.command.transition,
          attempts:
            axis === 'attempt'
              ? [...fixture.command.transition.attempts, newAttempt]
              : fixture.command.transition.attempts,
          nodes:
            axis === 'node'
              ? [...fixture.command.transition.nodes, newNode]
              : fixture.command.transition.nodes,
          outputs: axis === 'output' ? [newOutput] : [],
        },
      };
      const collisionNode = nodeFixture({
        ...newNode,
        id: 'collision-node',
      });
      const store = new LogicalRunStoreFake(progressionTransactionNow);
      store.seed({
        attempts: axis === 'attempt' ? [newAttempt] : [],
        nodes: axis === 'node' ? [...fixture.nodes, collisionNode] : fixture.nodes,
        outputs: axis === 'output' ? [newOutput] : [],
        runs: [fixture.run],
      });

      await expect(
        store.transaction((transaction) => transaction.commit(command)),
      ).resolves.toMatchObject({
        conflict: { code: axis === 'node' ? 'STALE_ACTIVATION' : 'REVISION_CONFLICT' },
        kind: 'conflict',
      });
    },
  );
});
