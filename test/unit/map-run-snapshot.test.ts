import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { runWorkflowName } from '../../src/dbos/dbos-names.js';
import { mapRunSnapshot } from '../../src/dbos/read-model/map-run-snapshot.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const runId = 'run-id';
const workflowInput = () => ({
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
  workflowID: `rr:run:${runId}`,
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

  it.each([
    [
      'ERROR',
      'execution failed',
      { code: 'workflow_failed', message: 'Workflow execution failed.' },
    ],
    [
      'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
      new Error('recovery failed'),
      {
        code: 'recovery_exhausted',
        message: 'Workflow recovery attempts were exhausted.',
      },
    ],
  ] as const)('redacts DBOS %s details behind a stable failure', (status, error, expectedError) => {
    expect(
      mapRunSnapshot(workflowStatus({ error, output: undefined, status }), runWorkflowName, runId),
    ).toMatchObject({ error: expectedError });
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
    ).toThrow('Run workflow input is invalid.');
  });

  it('rejects a persisted execution plan whose root pipeline is missing', () => {
    const executionPlan = { ...terminalExecutionPlan(), rootPipelineId: 'missing' };

    expect(() =>
      mapRunSnapshot(
        workflowStatus({ input: [{ ...workflowInput(), executionPlan }] }),
        runWorkflowName,
        runId,
      ),
    ).toThrow('Run workflow input is invalid.');
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

  it.each([
    [
      'an update before creation',
      { createdAt: 3, updatedAt: 2 },
      'DBOS workflow timestamps are inverted.',
    ],
    [
      'completion after the last update',
      { createdAt: 1, completedAt: 3, updatedAt: 2 },
      'DBOS workflow completion timestamp is inverted.',
    ],
  ] as const)('rejects %s', (_caseName, timestamps, message) => {
    expect(() => mapRunSnapshot(workflowStatus(timestamps), runWorkflowName, runId)).toThrow(
      message,
    );
  });

  it('rejects a workflow that is not owned by Revo', () => {
    expect(() =>
      mapRunSnapshot(workflowStatus({ workflowName: 'foreign' }), runWorkflowName, runId),
    ).toThrow('Workflow is not a Revo run.');
  });

  it.each([
    ['foreign namespace', `foreign:run:${runId}`],
    ['another owned run', 'rr:run:Foreign_1'],
    ['wrong kind', `rr:other:${runId}`],
    ['cross-kind', `rr:scope:${runId}`],
    ['malformed', 'not-a-workflow-id'],
  ])('rejects a %s root workflow ID', (_caseName, workflowID) => {
    expect(() => mapRunSnapshot(workflowStatus({ workflowID }), runWorkflowName, runId)).toThrow(
      'Workflow is not a Revo run.',
    );
  });

  it('rejects malformed durable workflow input', () => {
    expect(() => mapRunSnapshot(workflowStatus({ input: [] }), runWorkflowName, runId)).toThrow(
      'Run workflow input is invalid.',
    );
  });

  it('rejects malformed durable workflow output', () => {
    expect(() => mapRunSnapshot(workflowStatus({ output: null }), runWorkflowName, runId)).toThrow(
      'Run workflow output is invalid.',
    );
  });

  it('rejects an unknown DBOS workflow status', () => {
    expect(() =>
      mapRunSnapshot(
        workflowStatus({ output: undefined, status: 'UNKNOWN' }),
        runWorkflowName,
        runId,
      ),
    ).toThrow('Unknown DBOS workflow status: UNKNOWN.');
  });

  it('rejects a malformed DBOS status envelope before mapping it', () => {
    const malformed = workflowStatus();
    Object.defineProperty(malformed, 'applicationID', { value: undefined });
    expect(() => mapRunSnapshot(malformed, runWorkflowName, runId)).toThrow(
      'DBOS workflow status envelope is invalid.',
    );
  });
});
