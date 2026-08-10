import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { runWorkflowName } from '../../src/dbos/dbos-names.js';
import { mapRunSnapshot, RunOwnershipError } from '../../src/dbos/read-model/map-run-snapshot.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const runId = 'run-id';
const workflowInput = () => ({
  contractVersion: 2,
  runId,
  admissionToken: 'a'.repeat(43),
  executionPlan: terminalExecutionPlan(),
  input: null,
});

const workflowStatus = (overrides: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  input: [workflowInput()],
  output: { status: 'succeeded', outcome: 'succeeded' },
  priority: 0,
  status: 'SUCCESS',
  updatedAt: 2,
  workflowClassName: '',
  workflowID: `rr:run:v2:${runId}`,
  workflowName: runWorkflowName,
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
    const output =
      dbosStatus === 'SUCCESS' ? { status: 'succeeded', outcome: 'succeeded' } : undefined;

    expect(
      mapRunSnapshot(workflowStatus({ output, status: dbosStatus }), runWorkflowName, runId),
    ).toMatchObject({
      id: 'run-id',
      status: runStatus,
      createdAt: new Date(1),
      updatedAt: new Date(2),
    });
  });

  it('preserves stable failure codes while redacting DBOS error details', () => {
    expect(
      mapRunSnapshot(
        workflowStatus({ error: 'execution failed', output: undefined, status: 'ERROR' }),
        runWorkflowName,
        runId,
      ),
    ).toMatchObject({
      error: { code: 'workflow_failed', message: 'Workflow execution failed.' },
    });
    expect(
      mapRunSnapshot(
        workflowStatus({
          error: new Error('recovery failed'),
          output: undefined,
          status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
        }),
        runWorkflowName,
        runId,
      ),
    ).toMatchObject({
      error: {
        code: 'recovery_exhausted',
        message: 'Workflow recovery attempts were exhausted.',
      },
    });
  });

  it.each(['cancelled', 'failed'] as const)(
    'uses the pipeline terminal status %s after successful workflow completion',
    (terminalStatus) => {
      expect(
        mapRunSnapshot(
          workflowStatus({
            output: { status: terminalStatus, outcome: `terminal-${terminalStatus}` },
          }),
          runWorkflowName,
          runId,
        ),
      ).toMatchObject({
        status: terminalStatus,
        result: { outcome: `terminal-${terminalStatus}` },
      });
    },
  );

  it('preserves normalized output values without reinterpreting nested JSON', () => {
    const output = {
      result: {
        kind: 'json',
        value: { kind: 'secret', reference: { name: 'production-token' } },
      },
    } as const;

    expect(
      mapRunSnapshot(
        workflowStatus({ output: { status: 'succeeded', outcome: 'completed', output } }),
        runWorkflowName,
        runId,
      ),
    ).toMatchObject({ result: { outcome: 'completed', output } });
  });

  it('rejects an unsupported persisted execution plan schema', () => {
    const executionPlan = { ...terminalExecutionPlan(), schemaVersion: 2 };

    expect(() =>
      mapRunSnapshot(
        workflowStatus({ input: [{ ...workflowInput(), executionPlan }] }),
        runWorkflowName,
        runId,
      ),
    ).toThrow(RunOwnershipError);
  });

  it('rejects a persisted execution plan whose root pipeline is missing', () => {
    const executionPlan = { ...terminalExecutionPlan(), rootPipelineId: 'missing' };

    expect(() =>
      mapRunSnapshot(
        workflowStatus({ input: [{ ...workflowInput(), executionPlan }] }),
        runWorkflowName,
        runId,
      ),
    ).toThrow(RunOwnershipError);
  });

  it('rejects a secret as a normalized executor output value', () => {
    const output = {
      credential: { kind: 'secret', reference: { name: 'production-token' } },
    };

    expect(() =>
      mapRunSnapshot(
        workflowStatus({ output: { status: 'succeeded', outcome: 'completed', output } }),
        runWorkflowName,
        runId,
      ),
    ).toThrow('Run workflow output is invalid.');
  });

  it('rejects foreign workflows and malformed durable values', () => {
    expect(() =>
      mapRunSnapshot(workflowStatus({ workflowName: 'foreign' }), runWorkflowName, runId),
    ).toThrow('Workflow is not a Revo run.');
    expect(() => mapRunSnapshot(workflowStatus({ input: [] }), runWorkflowName, runId)).toThrow(
      RunOwnershipError,
    );
    expect(() => mapRunSnapshot(workflowStatus({ output: null }), runWorkflowName, runId)).toThrow(
      'Run workflow output is invalid.',
    );
    expect(() =>
      mapRunSnapshot(workflowStatus({ status: 'UNKNOWN' }), runWorkflowName, runId),
    ).toThrow('Unknown DBOS workflow status: UNKNOWN.');
  });
});
