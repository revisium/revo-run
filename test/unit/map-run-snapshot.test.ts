import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { mapRunSnapshot } from '../../src/runtime/map-run-snapshot.js';
import { terminalExecutionPlan } from '../support/terminal-execution-plan.js';

const workflowName = 'revo-run.run.v1';

const workflowStatus = (overrides: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  input: [{ executionPlan: terminalExecutionPlan(), input: null }],
  output: { outcome: 'succeeded' },
  priority: 0,
  status: 'SUCCESS',
  updatedAt: 2,
  workflowClassName: '',
  workflowID: 'run-id',
  workflowName,
  ...overrides,
});

describe('run snapshot mapping', () => {
  it.each([
    ['ENQUEUED', 'pending'],
    ['DELAYED', 'pending'],
    ['PENDING', 'running'],
    ['SUCCESS', 'succeeded'],
    ['CANCELLED', 'cancelled'],
    ['ERROR', 'failed'],
    ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'failed'],
  ])('maps DBOS status %s to %s', (dbosStatus, runStatus) => {
    const output = dbosStatus === 'SUCCESS' ? { outcome: 'succeeded' } : undefined;

    expect(
      mapRunSnapshot(workflowStatus({ output, status: dbosStatus }), workflowName),
    ).toMatchObject({
      id: 'run-id',
      status: runStatus,
      createdAt: new Date(1),
      updatedAt: new Date(2),
    });
  });

  it('maps workflow and recovery errors to stable public codes', () => {
    expect(
      mapRunSnapshot(
        workflowStatus({ error: 'execution failed', output: undefined, status: 'ERROR' }),
        workflowName,
      ),
    ).toMatchObject({
      error: { code: 'workflow_failed', message: 'execution failed' },
    });
    expect(
      mapRunSnapshot(
        workflowStatus({
          error: new Error('recovery failed'),
          output: undefined,
          status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
        }),
        workflowName,
      ),
    ).toMatchObject({
      error: { code: 'recovery_exhausted', message: 'recovery failed' },
    });
  });

  it('rejects foreign workflows and malformed durable values', () => {
    expect(() => mapRunSnapshot(workflowStatus({ workflowName: 'foreign' }), workflowName)).toThrow(
      'Workflow is not a Revo run.',
    );
    expect(() => mapRunSnapshot(workflowStatus({ input: [] }), workflowName)).toThrow(
      'Run workflow input is invalid.',
    );
    expect(() => mapRunSnapshot(workflowStatus({ output: null }), workflowName)).toThrow(
      'Run workflow output is invalid.',
    );
    expect(() => mapRunSnapshot(workflowStatus({ status: 'UNKNOWN' }), workflowName)).toThrow(
      'Unknown DBOS workflow status: UNKNOWN.',
    );
  });
});
