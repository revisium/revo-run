import { Error as DBOSError } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import type {
  RunExecutorRequest,
  RunExecutorResult,
} from '../../src/contracts/executor/run-executor.js';
import type { RunNodeExecution } from '../../src/contracts/executor/run-node-execution.js';
import { nodeExecutionStepName } from '../../src/dbos/dbos-names.js';
import { mapRunAttempt } from '../../src/dbos/read-model/map-run-attempt.js';
import { createAttemptId } from '../../src/pipeline/identity/execution-identity.js';
import { observable, plan, runId, step } from '../support/run-details.fixture.js';

const candidate = observable.nodesByDisplayPath.get('main/root-work');
if (candidate === undefined) {
  throw new Error('Root work candidate is missing.');
}
const binding = plan.bindings.find(
  ({ target }) =>
    target.pipelineId === candidate.pipelineId && target.nodePath === candidate.nodePath,
);
if (binding === undefined) {
  throw new Error('Root work binding is missing.');
}

const executionRequest = (overrides: Partial<RunExecutorRequest> = {}): RunExecutorRequest => ({
  runId,
  authoredNodeId: candidate.authoredNodeId,
  scopeId: candidate.scopeId,
  nodeInstanceId: candidate.id,
  attemptId: createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal: 1 }),
  attemptOrdinal: 1,
  displayPath: candidate.displayPath,
  pipelineId: candidate.pipelineId,
  nodePath: candidate.nodePath,
  binding,
  input: {},
  ...overrides,
});

const storedExecution = (
  result: RunExecutorResult,
  request: RunExecutorRequest = executionRequest(),
): RunNodeExecution => ({ kind: 'runNodeExecution', request, result });

const differentIdentity = (identity: string): string =>
  `${identity.slice(0, -1)}${identity.endsWith('A') ? 'B' : 'A'}`;

const identityMismatches: ReadonlyArray<
  readonly [string, (request: RunExecutorRequest) => RunExecutorRequest]
> = [
  ['runId', (request) => ({ ...request, runId: 'Other_1' })],
  ['scopeId', (request) => ({ ...request, scopeId: differentIdentity(request.scopeId) })],
  [
    'authoredNodeId',
    (request) => ({
      ...request,
      authoredNodeId: differentIdentity(request.authoredNodeId),
    }),
  ],
  [
    'nodeInstanceId',
    (request) => ({
      ...request,
      nodeInstanceId: differentIdentity(request.nodeInstanceId),
    }),
  ],
  ['attemptId', (request) => ({ ...request, attemptId: differentIdentity(request.attemptId) })],
  ['attemptOrdinal', (request) => ({ ...request, attemptOrdinal: 2 })],
  ['pipelineId', (request) => ({ ...request, pipelineId: 'other' })],
  ['nodePath', (request) => ({ ...request, nodePath: 'other' })],
  ['displayPath', (request) => ({ ...request, displayPath: 'main/other' })],
];

describe('stored run attempt mapping', () => {
  it('maps a completed execution and its timestamps', () => {
    const attempt = mapRunAttempt(
      step(1, nodeExecutionStepName('main/root-work', 1), {
        output: storedExecution({
          kind: 'completed',
          outcome: 'approved',
          output: { answer: { kind: 'json', value: 42 } },
        }),
      }),
      candidate,
      runId,
      1,
    );

    expect(attempt).toEqual({
      id: createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal: 1 }),
      nodeInstanceId: candidate.id,
      ordinal: 1,
      status: 'completed',
      outcome: 'approved',
      output: { answer: { kind: 'json', value: 42 } },
      startedAt: new Date(6),
      completedAt: new Date(7),
    });
  });

  it('maps a later attempt from its ordinal-derived identity', () => {
    const attemptOrdinal = 2;
    const attemptId = createAttemptId({ nodeInstanceId: candidate.id, attemptOrdinal });
    const request = executionRequest({ attemptId, attemptOrdinal });

    const attempt = mapRunAttempt(
      step(2, nodeExecutionStepName('main/root-work', attemptOrdinal), {
        output: storedExecution({ kind: 'completed', outcome: 'approved' }, request),
      }),
      candidate,
      runId,
      attemptOrdinal,
    );

    expect(attempt).toMatchObject({ id: attemptId, ordinal: attemptOrdinal, status: 'completed' });
  });

  it('redacts executor failure details', () => {
    const attempt = mapRunAttempt(
      step(1, nodeExecutionStepName('main/root-work', 1), {
        output: storedExecution({
          kind: 'failed',
          error: { code: 'provider_failed', message: 'secret executor detail' },
        }),
      }),
      candidate,
      runId,
      1,
    );

    expect(attempt).toMatchObject({
      status: 'failed',
      error: { code: 'provider_failed' },
    });
    expect(JSON.stringify(attempt)).not.toContain('secret executor detail');
  });

  it('maps a DBOS step timeout without exposing the provider error', () => {
    const attempt = mapRunAttempt(
      step(1, nodeExecutionStepName('main/root-work', 1), {
        error: new DBOSError.DBOSStepTimeoutError('secret timeout detail', 10),
      }),
      candidate,
      runId,
      1,
    );

    expect(attempt).toMatchObject({ status: 'timedOut' });
    expect(JSON.stringify(attempt)).not.toContain('secret timeout detail');
  });

  it('sanitizes a non-timeout DBOS step error', () => {
    const attempt = mapRunAttempt(
      step(1, nodeExecutionStepName('main/root-work', 1), {
        error: new Error('secret provider detail'),
      }),
      candidate,
      runId,
      1,
    );

    expect(attempt).toMatchObject({ status: 'failed', error: { code: 'step_failed' } });
    expect(JSON.stringify(attempt)).not.toContain('secret provider detail');
  });

  it('rejects a malformed stored execution schema', () => {
    const malformed = step(1, nodeExecutionStepName('main/root-work', 1), {
      output: { kind: 'runNodeExecution', request: {}, result: { kind: 'completed' } },
    });

    expect(() => mapRunAttempt(malformed, candidate, runId, 1)).toThrow(
      'Stored node execution is invalid.',
    );
  });

  it.each(identityMismatches)('rejects a stored execution with mismatching %s', (_field, alter) => {
    const execution = storedExecution(
      { kind: 'completed', outcome: 'completed' },
      alter(executionRequest()),
    );

    expect(() =>
      mapRunAttempt(
        step(1, nodeExecutionStepName('main/root-work', 1), { output: execution }),
        candidate,
        runId,
        1,
      ),
    ).toThrow('Stored node execution identity is invalid.');
  });
});
