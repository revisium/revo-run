import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import {
  commandDispatchWorkflowName,
  parallelBranchWorkflowName,
  parallelBranchWorkflowV2Name,
  runExecutionWorkflowName,
  runExecutionWorkflowV2Name,
  runWorkflowName,
  runWorkflowV2Name,
} from '../../src/dbos/dbos-names.js';
import { mapRunSnapshot } from '../../src/dbos/read-model/map-run-snapshot.js';
import {
  commandWorkflowId,
  runWorkflowId,
  scopeWorkflowId,
  scopeWorkflowV2Id,
} from '../../src/dbos/workflow-id.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const input = {
  runId: 'Run_1',
  admissionToken: 'a'.repeat(43),
  executionPlan: terminalExecutionPlan(),
  input: null,
};

const status = (workflowName: string): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  input: [input],
  output: { status: 'cancelled', outcome: 'cancelled' },
  priority: 0,
  status: 'SUCCESS',
  updatedAt: 2,
  workflowClassName: '',
  workflowID: runWorkflowId(input.runId),
  workflowName,
});

describe('RR-07 durable version routing', () => {
  it('keeps one permanent root slot while versioning scope and command identities', () => {
    expect(runWorkflowId('Run_1')).toBe('rr:run:v1:Run_1');
    expect(scopeWorkflowId('sc1_A')).toBe('rr:scope:v1:sc1_A');
    expect(scopeWorkflowV2Id('sc1_A')).toBe('rr:scope:v2:sc1_A');
    expect(commandWorkflowId('cmd_00000000-0000-4000-8000-000000000000')).toBe(
      'rr:command:v1:cmd_00000000-0000-4000-8000-000000000000',
    );
  });

  it('pins exact v1/v2 and dispatcher workflow names', () => {
    expect([
      runWorkflowName,
      runExecutionWorkflowName,
      parallelBranchWorkflowName,
      runWorkflowV2Name,
      runExecutionWorkflowV2Name,
      parallelBranchWorkflowV2Name,
      commandDispatchWorkflowName,
    ]).toEqual([
      'revo-run.run.v1',
      'revo-run.execution.v1',
      'revo-run.parallel-branch.v1',
      'revo-run.run.v2',
      'revo-run.execution.v2',
      'revo-run.parallel-branch.v2',
      'revo-run.command-dispatch.v1',
    ]);
  });

  it('maps the exact v2 root name and rejects cross-version parsing', () => {
    expect(mapRunSnapshot(status(runWorkflowV2Name), runWorkflowV2Name, input.runId)).toMatchObject(
      { id: input.runId, status: 'cancelled' },
    );
    expect(() => mapRunSnapshot(status(runWorkflowV2Name), runWorkflowName, input.runId)).toThrow(
      'Workflow is not a Revo run.',
    );
  });
});
