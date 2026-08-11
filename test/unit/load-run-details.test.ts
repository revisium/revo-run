import type { ListWorkflowStepsOptions, WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TestStepInfo } from '../support/run-details.fixture.js';

const dbos = vi.hoisted(() => ({
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<WorkflowStatus | null>>(),
  listWorkflowSteps:
    vi.fn<
      (
        workflowId: string,
        options?: ListWorkflowStepsOptions,
      ) => Promise<TestStepInfo[] | undefined>
    >(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { runExecutionWorkflowName } from '../../src/dbos/dbos-names.js';
import { loadRunDetails } from '../../src/dbos/read-model/load-run-details.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import {
  rootScope,
  runDetailsStatuses,
  runDetailsSteps,
  snapshot,
  step,
} from '../support/run-details.fixture.js';

describe('recursive run details projection', () => {
  beforeEach(() => {
    dbos.getWorkflowStatus.mockReset();
    dbos.listWorkflowSteps.mockReset();
    const statuses = runDetailsStatuses();
    dbos.getWorkflowStatus.mockImplementation(async (id: string) => statuses.get(id) ?? null);

    const steps = runDetailsSteps();
    dbos.listWorkflowSteps.mockImplementation(
      async (id: string, { limit = 100, offset = 0 } = {}) =>
        (steps.get(id) ?? []).slice(offset, offset + limit),
    );
  });

  it('maps depth-first scopes and terminal attempts', async () => {
    const details = await loadRunDetails(snapshot);

    expect(details.scopes.map(({ kind, displayPath }) => [kind, displayPath])).toEqual([
      ['root', 'main'],
      ['inlineSubpipeline', 'main/review'],
      ['parallelBranch', 'main/batch/a'],
      ['parallelBranch', 'main/batch/b'],
    ]);
    expect(details.nodeInstances.map(({ displayPath, status }) => [displayPath, status])).toEqual([
      ['main/root-work', 'completed'],
      ['main/review/check', 'failed'],
      ['main/batch/a', 'completed'],
      ['main/batch/b', 'timedOut'],
    ]);
    expect(details.attempts.map(({ status }) => status)).toEqual([
      'completed',
      'failed',
      'completed',
      'timedOut',
    ]);
  });

  it('does not expose executor details or admitted-plan internals', async () => {
    const details = await loadRunDetails(snapshot);
    const observableDetails = JSON.stringify({
      scopes: details.scopes,
      nodeInstances: details.nodeInstances,
      attempts: details.attempts,
    });
    expect(observableDetails).not.toContain('secret detail');
    expect(observableDetails).not.toContain('binding');
    expect(observableDetails).not.toContain('input');
  });

  it('rejects a duplicate child reference instead of silently deduplicating it', async () => {
    if (rootScope === undefined) {
      throw new Error('Root scope is missing.');
    }
    dbos.listWorkflowSteps.mockResolvedValue([
      step(1, runExecutionWorkflowName, { childWorkflowID: scopeWorkflowId(rootScope.id) }),
      step(2, runExecutionWorkflowName, { childWorkflowID: scopeWorkflowId(rootScope.id) }),
    ]);

    await expect(loadRunDetails(snapshot)).rejects.toThrow('cycle or duplicate');
  });

  it('rejects inverted step timestamps', async () => {
    dbos.listWorkflowSteps.mockResolvedValue([
      {
        ...step(1, runExecutionWorkflowName),
        completedAtEpochMs: 5,
        startedAtEpochMs: 6,
      },
    ]);
    await expect(loadRunDetails(snapshot)).rejects.toThrow('timestamps are inverted');
  });

  it('rejects additional step properties', async () => {
    const stepWithUnapprovedProperty = {
      ...step(1, runExecutionWorkflowName),
      unapproved: true,
    };
    dbos.listWorkflowSteps.mockResolvedValue([stepWithUnapprovedProperty]);
    await expect(loadRunDetails(snapshot)).rejects.toThrow('step record is invalid');
  });

  it('rejects inverted durable scope timestamps', async () => {
    if (rootScope === undefined) {
      throw new Error('Root scope is missing.');
    }
    const rootWorkflowId = scopeWorkflowId(rootScope.id);
    const status = await dbos.getWorkflowStatus(rootWorkflowId);
    if (status === null) {
      throw new Error('Root scope status is missing.');
    }
    dbos.getWorkflowStatus.mockResolvedValue({ ...status, createdAt: 3, updatedAt: 2 });

    await expect(loadRunDetails(snapshot)).rejects.toThrow('scope timestamps are inverted');
  });
});
