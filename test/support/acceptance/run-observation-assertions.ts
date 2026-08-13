import assert from 'node:assert/strict';

import { vi } from 'vitest';

import type { RunDetails, RunEvent, RunManager, RunStatus } from '../../../src/index.js';
import type { ScenarioStep } from '../../dsl/scenario.js';
import type { RunEventExpectations } from './run-event-expectations.js';

const terminal = (status: RunStatus): boolean => status !== 'pending' && status !== 'running';

export class RunObservationAssertions {
  private readonly events: RunEventExpectations;
  private readonly manager: RunManager;
  private readonly runId: string;

  constructor(manager: RunManager, runId: string, events: RunEventExpectations) {
    this.manager = manager;
    this.runId = runId;
    this.events = events;
  }

  async expectOutputValue(path: string, key: string, value: unknown): Promise<void> {
    await vi.waitFor(async () => {
      const details = await this.details();
      const attempt = this.attemptForPath(details, path);
      if (attempt?.status === 'completed') {
        assert.deepStrictEqual(attempt.output?.[key], value);
        return;
      }
      const node = details.nodeInstances.find(({ displayPath }) => displayPath === path);
      assert.equal(node?.status, 'completed');
      assert('result' in details.run);
      assert.deepStrictEqual(details.run.result.output?.[key], value);
    });
  }

  async expectJsonOutput(
    path: string,
    key: string,
    pointer: string | undefined,
    value: unknown,
  ): Promise<void> {
    await vi.waitFor(async () => {
      const attempt = this.attemptForPath(await this.details(), path);
      assert(attempt?.status === 'completed');
      const output = attempt.output?.[key];
      assert(output?.kind === 'json');
      assert.equal(pointer, undefined);
      assert.deepStrictEqual(output.value, value);
    });
  }

  async expectCursorOrder(captures: readonly string[]): Promise<void> {
    this.events.expectCursorOrder(await this.eventsAfterTerminal(), captures);
  }

  async expectRunDetails(
    expected: Extract<ScenarioStep, { readonly kind: 'expectRunDetails' }>,
  ): Promise<void> {
    await vi.waitFor(
      async () => {
        const details = await this.details();
        assert.deepStrictEqual(
          new Set(details.nodeInstances.map(({ displayPath }) => displayPath)),
          new Set(expected.nodePaths),
        );
        if (expected.scopePaths !== undefined) {
          assert.deepStrictEqual(
            new Set(details.scopes.map(({ displayPath }) => displayPath)),
            new Set(expected.scopePaths),
          );
        }
        if (expected.attempts !== undefined) {
          const attempts = details.nodeInstances.flatMap((node) =>
            node.attemptIds.map((attemptId) => {
              const attempt = details.attempts.find(({ id }) => id === attemptId);
              assert(attempt !== undefined);
              return {
                nodePath: node.displayPath,
                ordinal: attempt.ordinal,
                status: attempt.status,
              };
            }),
          );
          assert.deepStrictEqual(attempts, expected.attempts);
        }
      },
      { timeout: 5_000 },
    );
  }

  async expectSecretAbsent(value: string): Promise<void> {
    await this.waitForTerminal();
    const stored = JSON.stringify({
      run: await this.manager.getRun(this.runId),
      details: await this.manager.getRunDetails(this.runId),
      events: await this.collectEvents(),
    });
    assert(!stored.includes(value));
  }

  async eventsAfterTerminal(): Promise<readonly RunEvent[]> {
    await this.waitForTerminal();
    return this.collectEvents();
  }

  private async details(): Promise<RunDetails> {
    const details = await this.manager.getRunDetails(this.runId);
    if (details === undefined) {
      throw new Error(`Run ${this.runId} was not found.`);
    }
    return details;
  }

  private async waitForTerminal(): Promise<void> {
    await vi.waitFor(
      async () => {
        const run = await this.manager.getRun(this.runId);
        assert(run !== undefined && terminal(run.status));
      },
      { timeout: 5_000 },
    );
  }

  private async collectEvents(): Promise<readonly RunEvent[]> {
    return (await this.manager.getRunEvents(this.runId, { limit: 100 })).items;
  }

  private attemptForPath(details: RunDetails, path: string) {
    const node = details.nodeInstances.find(({ displayPath }) => displayPath === path);
    let latestCompleted: RunDetails['attempts'][number] | undefined;
    for (const attemptId of node?.attemptIds ?? []) {
      const attempt = details.attempts.find(({ id }) => id === attemptId);
      if (
        attempt?.status === 'completed' &&
        (latestCompleted === undefined || attempt.ordinal > latestCompleted.ordinal)
      ) {
        latestCompleted = attempt;
      }
    }
    return latestCompleted;
  }
}
