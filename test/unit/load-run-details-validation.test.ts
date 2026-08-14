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

import { runCommandDecisionStepName, runExecutionWorkflowName } from '../../src/dbos/dbos-names.js';
import { loadRunDetails } from '../../src/dbos/read-model/load-run-details.js';
import { runWorkflowId, scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { task } from '../dsl/pipeline-builder.js';
import { runDetailsHumanResolutionFixture } from '../support/run-details-command.fixture.js';
import {
  branchScopes,
  rootScope,
  runDetailsStatuses,
  runDetailsSteps,
  runId,
  snapshot,
  step,
} from '../support/run-details.fixture.js';

let statuses: Map<string, WorkflowStatus>;
let steps: Map<string, readonly TestStepInfo[]>;

const statusFor = (workflowId: string): WorkflowStatus => {
  const status = statuses.get(workflowId);
  if (status === undefined) {
    throw new Error(`Missing fixture status ${workflowId}.`);
  }
  return status;
};

const branchWorkflowId = (index = 0): string => {
  const branch = branchScopes[index];
  if (branch === undefined) {
    throw new Error(`Missing fixture branch ${index}.`);
  }
  return scopeWorkflowId(branch.id);
};

const replaceBranchInput = (replacement: Readonly<Record<string, unknown>>): void => {
  const workflowId = branchWorkflowId();
  const status = statusFor(workflowId);
  const input = status.input?.[0];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Fixture parallel input is invalid.');
  }
  statuses.set(workflowId, { ...status, input: [{ ...input, ...replacement }] });
};

describe('durable run details validation', () => {
  beforeEach(() => {
    statuses = runDetailsStatuses();
    steps = runDetailsSteps();
    dbos.getWorkflowStatus.mockReset();
    dbos.listWorkflowSteps.mockReset();
    dbos.getWorkflowStatus.mockImplementation(async (id: string) => statuses.get(id) ?? null);
    dbos.listWorkflowSteps.mockImplementation(
      async (id: string, { limit = 100, offset = 0 } = {}) =>
        (steps.get(id) ?? []).slice(offset, offset + limit),
    );
  });

  it.each(['failed', 'cancelled'] as const)(
    'uses logical root result status %s after DBOS SUCCESS',
    async (status) => {
      if (rootScope === undefined) {
        throw new Error('Root fixture scope is missing.');
      }
      const workflowId = scopeWorkflowId(rootScope.id);
      statuses.set(workflowId, {
        ...statusFor(workflowId),
        output: { status, outcome: `logical-${status}` },
      });

      const details = await loadRunDetails(snapshot);

      expect(details.scopes[0]).toMatchObject({ kind: 'root', status });
    },
  );

  it.each([
    ['branchKey', { branchKey: 'b' }],
    ['node', { node: task('different') }],
    ['pipelineId', { pipelineId: 'review' }],
    ['runtimePath', { runtimePath: 'elsewhere' }],
    ['parentPath', { parentPath: 'elsewhere' }],
  ])('rejects a parallel scope with mismatching stable %s', async (_field, replacement) => {
    replaceBranchInput(replacement);

    await expect(loadRunDetails(snapshot)).rejects.toThrow(
      'Parallel scope durable identity is invalid.',
    );
  });

  it('accepts schema-valid dynamic parallel input fields without pinning them to the plan', async () => {
    replaceBranchInput({
      inheritedOutputs: [],
      maximumParallelism: 2,
      pipelineInput: { kind: 'value', value: { kind: 'json', value: { changed: true } } },
    });

    await expect(loadRunDetails(snapshot)).resolves.toMatchObject({ run: { id: runId } });
  });

  it('rejects a malformed branch output', async () => {
    const workflowId = branchWorkflowId();
    statuses.set(workflowId, { ...statusFor(workflowId), output: null });
    await expect(loadRunDetails(snapshot)).rejects.toThrow(
      'Parallel branch workflow result is invalid.',
    );
  });

  it('rejects a branch output with a different durable identity', async () => {
    const workflowId = branchWorkflowId();
    statuses.set(workflowId, {
      ...statusFor(workflowId),
      output: { kind: 'continued', key: 'b', outcome: 'completed', outputs: [] },
    });
    await expect(loadRunDetails(snapshot)).rejects.toThrow(
      'Parallel branch workflow output identity is invalid.',
    );
  });

  it('rejects an invalid root parent workflow relationship', async () => {
    if (rootScope === undefined) {
      throw new Error('Root fixture scope is missing.');
    }
    const rootWorkflow = scopeWorkflowId(rootScope.id);
    statuses.set(rootWorkflow, { ...statusFor(rootWorkflow), parentWorkflowID: 'foreign' });
    await expect(loadRunDetails(snapshot)).rejects.toThrow('workflow parent is invalid');
  });

  it('rejects an invalid branch parent workflow relationship', async () => {
    const branchWorkflow = branchWorkflowId();
    statuses.set(branchWorkflow, {
      ...statusFor(branchWorkflow),
      parentWorkflowID: runWorkflowId(runId),
    });
    await expect(loadRunDetails(snapshot)).rejects.toThrow('workflow parent is invalid');
  });

  it('rejects unsupported child workflow links', async () => {
    steps.set(runWorkflowId(runId), [
      step(1, 'foreign.workflow', { childWorkflowID: 'foreign-child' }),
    ]);
    await expect(loadRunDetails(snapshot)).rejects.toThrow('unsupported child workflow link');
  });

  it('rejects getResult links without a prior child introduction', async () => {
    steps.set(runWorkflowId(runId), [
      step(1, 'DBOS.getResult', { childWorkflowID: 'foreign-child' }),
    ]);
    await expect(loadRunDetails(snapshot)).rejects.toThrow('unsupported child workflow link');
  });

  it('rejects a decision whose step identity does not match its payload command', async () => {
    const fixture = runDetailsHumanResolutionFixture();
    const wrapperId = runWorkflowId(fixture.snapshot.id);
    statuses = fixture.statuses;
    steps = new Map(fixture.acceptedAdoptionSteps);
    steps.set(
      wrapperId,
      (steps.get(wrapperId) ?? []).map((candidate) =>
        candidate.name === runCommandDecisionStepName(fixture.commandId)
          ? {
              ...candidate,
              name: runCommandDecisionStepName('cmd_11111111-1111-4111-8111-111111111111'),
            }
          : candidate,
      ),
    );

    await expect(loadRunDetails(fixture.snapshot)).rejects.toThrow(
      'Run command decision identity is invalid.',
    );
  });

  it('loads an introduced root scope after 99,997 preceding valid steps without stack growth', async () => {
    if (rootScope === undefined) {
      throw new Error('Root fixture scope is missing.');
    }
    const childWorkflowID = scopeWorkflowId(rootScope.id);
    const fillerCount = 99_997;
    steps.set(runWorkflowId(runId), [
      ...Array.from({ length: fillerCount }, (_, index) => step(index + 1, 'DBOS.sleep')),
      step(fillerCount + 1, runExecutionWorkflowName, { childWorkflowID }),
      step(fillerCount + 2, 'DBOS.getResult', { childWorkflowID }),
    ]);

    await expect(loadRunDetails(snapshot)).resolves.toMatchObject({ run: { id: runId } });
    expect(dbos.listWorkflowSteps).toHaveBeenCalledWith(runWorkflowId(runId), {
      limit: 100,
      offset: 99_900,
    });
  }, 20_000);

  it('validates every consumed workflow status envelope', async () => {
    if (rootScope === undefined) {
      throw new Error('Root fixture scope is missing.');
    }
    const workflowId = scopeWorkflowId(rootScope.id);
    const status = statusFor(workflowId);
    Object.defineProperty(status, 'applicationID', { value: undefined });

    await expect(loadRunDetails(snapshot)).rejects.toThrow(
      'DBOS workflow status envelope is invalid.',
    );
  });
});
