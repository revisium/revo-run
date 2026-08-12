import type { GetWorkflowsInput, WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  listWorkflows: vi.fn<(input?: GetWorkflowsInput) => Promise<WorkflowStatus[]>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { runWorkflowName } from '../../src/dbos/dbos-names.js';
import { loadRunPage } from '../../src/dbos/read-model/load-run-page.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const status = (runId: string, overrides: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 100,
  input: [
    {
      runId,
      admissionToken: 'a'.repeat(43),
      executionPlan: terminalExecutionPlan(),
      input: null,
    },
  ],
  output: { status: 'succeeded', outcome: 'completed' },
  priority: 0,
  status: 'SUCCESS',
  updatedAt: 200,
  workflowClassName: '',
  workflowID: `rr:run:v1:${runId}`,
  workflowName: runWorkflowName,
  ...overrides,
});

describe('DBOS-backed run listing', () => {
  beforeEach(() => dbos.listWorkflows.mockReset());

  it('uses raw offset paging and exposes a continuation only for another owned match', async () => {
    const rows = [
      status('foreign', { workflowName: 'foreign.workflow' }),
      status('Run_1'),
      status('Run_2'),
    ];
    dbos.listWorkflows.mockImplementation(
      async ({ limit = 100, offset = 0 }: GetWorkflowsInput = {}) =>
        rows.slice(offset, offset + limit),
    );

    await expect(loadRunPage({ limit: 1 })).resolves.toEqual({
      items: [expect.objectContaining({ id: 'Run_1', status: 'succeeded' })],
      nextOffset: 2,
    });
    expect(dbos.listWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowName: runWorkflowName,
        workflow_id_prefix: 'rr:run:v1:',
        offset: 0,
        sortDesc: true,
        loadInput: true,
        loadOutput: true,
      }),
    );
    expect(dbos.listWorkflows).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 2, limit: 1 }),
    );
  });

  it('excludes a prefixed row whose parsed durable run ID is foreign', async () => {
    dbos.listWorkflows.mockResolvedValue([
      status('Run_1', {
        input: [
          {
            runId: 'Other_1',
            admissionToken: 'a'.repeat(43),
            executionPlan: terminalExecutionPlan(),
            input: null,
          },
        ],
      }),
      status('Run_2'),
    ]);

    await expect(loadRunPage({})).resolves.toEqual({
      items: [expect.objectContaining({ id: 'Run_2' })],
    });
  });

  it('fails instead of hiding a corrupt owned row', async () => {
    dbos.listWorkflows.mockResolvedValue([status('Run_1', { input: [] })]);

    await expect(loadRunPage({})).rejects.toThrow('Run workflow input is invalid.');
  });

  it('excludes rows from unversioned, retired, abandoned, and cross-kind ID namespaces', async () => {
    dbos.listWorkflows.mockResolvedValue([
      status('Unversioned_1', { workflowID: 'rr:run:Unversioned_1' }),
      status('Retired_2', { workflowID: 'rr:run:v2:Retired_2' }),
      status('Abandoned_3', { workflowID: 'rr:run:v3:Abandoned_3' }),
      status('CrossKind_1', { workflowID: 'rr:scope:v1:CrossKind_1' }),
      status('Owned_1'),
    ]);

    await expect(loadRunPage({})).resolves.toEqual({
      items: [expect.objectContaining({ id: 'Owned_1' })],
    });
  });

  it('fails closed for a malformed ID in the owned namespace', async () => {
    dbos.listWorkflows.mockResolvedValue([
      status('Malformed_1', { workflowID: 'rr:run:v1:malformed:run' }),
    ]);

    await expect(loadRunPage({})).rejects.toThrow('Owned run workflow ID is invalid.');
  });
});
