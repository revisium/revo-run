import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutionPlan, JsonValue, RunManager } from '../../src/index.js';
import {
  approvingParticipantExecutor,
  createClassifyExecutor,
} from './support/package-executors.js';
import {
  branchPlan,
  consensusPlan,
  delayPlan,
  mapPlan,
  parallelPlan,
  repeatPlan,
  subpipelinePlan,
} from './support/package-plans.js';
import { newPackageRunId, startPackageRunManager } from './support/package-run-manager.js';

const succeed = async (
  manager: RunManager,
  prefix: string,
  executionPlan: ExecutionPlan,
  input: JsonValue = null,
) => {
  const runId = newPackageRunId(prefix);
  await manager.startRun({ runId, executionPlan, input });
  const terminal = await manager.waitForTerminal(runId, { timeoutMs: 20_000 });
  expect(terminal.status).toBe('succeeded');
  const details = await manager.getRunDetails(runId);
  expect(details).toBeDefined();
  if (details === undefined) {
    throw new Error(`getRunDetails missed ${runId}.`);
  }
  return { details, runId, terminal };
};

describe('public pipeline kinds', () => {
  let manager: RunManager | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it('completes a durable delay without an executor effect', async () => {
    manager = await startPackageRunManager();
    const { details } = await succeed(manager, 'pkgDelay', delayPlan());
    expect(details.attempts).toEqual([]);
  });

  it('joins every successful parallel branch', async () => {
    manager = await startPackageRunManager();
    const { details } = await succeed(manager, 'pkgParallel', parallelPlan());
    expect(details.parallelJoins).toEqual([
      expect.objectContaining({
        outcome: 'succeeded',
        remaining: 'drain',
      }),
    ]);
    expect(details.attempts.filter((attempt) => attempt.status === 'completed')).toHaveLength(2);
  });

  it('selects the matching branch from a node output', async () => {
    manager = await startPackageRunManager(createClassifyExecutor('high'));
    const { details } = await succeed(manager, 'pkgBranch', branchPlan());
    expect(
      details.nodeInstances.some((node) => node.displayPath.endsWith('/security-review')),
    ).toBe(true);
  });

  it('maps a script task over run-input items', async () => {
    manager = await startPackageRunManager();
    const { details } = await succeed(manager, 'pkgMap', mapPlan(), {
      items: [{ id: 'a' }, { id: 'b' }],
    });
    expect(details.mapExecutions).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    expect(details.attempts.filter((attempt) => attempt.status === 'completed')).toHaveLength(2);
  });

  it('completes a bounded repeat on the first successful iteration', async () => {
    manager = await startPackageRunManager();
    const { details } = await succeed(manager, 'pkgRepeat', repeatPlan());
    expect(details.scopes.some((scope) => scope.kind === 'repeatIteration')).toBe(true);
    expect(details.attempts.filter((attempt) => attempt.status === 'completed')).toHaveLength(1);
  });

  it('executes a child subpipeline and returns to the parent', async () => {
    manager = await startPackageRunManager();
    const { details } = await succeed(manager, 'pkgSub', subpipelinePlan());
    expect(details.scopes.some((scope) => scope.pipelineId === 'child')).toBe(true);
    expect(details.attempts.filter((attempt) => attempt.status === 'completed')).toHaveLength(1);
  });

  it('approves a unanimous consensus from participant votes', async () => {
    manager = await startPackageRunManager(approvingParticipantExecutor);
    const { details } = await succeed(manager, 'pkgConsensus', consensusPlan());
    expect(details.consensuses).toEqual([
      expect.objectContaining({
        status: 'resolved',
        verdict: 'approved',
      }),
    ]);
    expect(details.consensuses[0]?.acceptedVotes).toHaveLength(2);
  });
});
