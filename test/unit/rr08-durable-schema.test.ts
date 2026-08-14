import { describe, expect, it } from 'vitest';

import { parseParallelBranchResult } from '../../src/validation/parallel-branch-result.validator.js';
import { parseParallelBranchWorkflowInput } from '../../src/validation/parallel-branch-workflow-input.validator.js';
import { parseDurableParallelJoinDecision } from '../../src/validation/parallel-join-decision.validator.js';
import {
  parseExecutionReservation,
  parseRunCoordinatorMessage,
  parseScopeStartFenceReply,
} from '../../src/validation/run-coordinator-message.validator.js';
import { parseRunNodeEffectSelection } from '../../src/validation/run-node-effect-selection.validator.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const request = storedNodeExecution('main/root-work', 'completed').request;
const scopeWorkflowId = `rr:scope:${request.scopeId}`;
const childWorkflowId = `rr:scope:sc1_${'c'.repeat(43)}`;
const runWorkflowId = `rr:run:${request.runId}`;
const commandId = 'cmd_12345678-1234-4123-8123-123456789abc';

const selection = {
  kind: 'runNodeEffectSelection',
  request,
  mode: 'execute',
  storedRecoveryGeneration: 0,
  liveRecoveryGeneration: 0,
} as const;

const branchResult = {
  status: 'completed',
  key: 'review',
  outcome: 'completed',
  outputs: [['main/review', { result: { kind: 'json', value: true } }]],
} as const;

const startFence = {
  directive: 'start',
  requestId: `request:${childWorkflowId}`,
  admissionId: `admission:${childWorkflowId}`,
  workflowId: childWorkflowId,
} as const;

const branchInput = {
  runId: request.runId,
  scopeId: `sc1_${'c'.repeat(43)}`,
  branchKey: 'review',
  node: { kind: 'end', status: 'succeeded', outcome: 'completed' },
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main',
  parentPath: 'review',
  inheritedOutputs: [],
  maximumParallelism: 2,
  parentWorkflowId: scopeWorkflowId,
  disposition: 'execute',
  startFence,
} as const;

const joinDecision = {
  kind: 'parallelJoinDecision',
  scopeId: request.scopeId,
  nodeInstanceId: request.nodeInstanceId,
  outcome: 'succeeded',
  remaining: 'cancel',
  settlements: [{ key: 'winner', outcome: 'completed' }],
  outputEligibleBranchKeys: ['winner'],
  skippedBranchKeys: ['pending'],
} as const;

const coordinatorMessages = [
  {
    name: 'event message',
    value: {
      kind: 'event',
      workflowId: scopeWorkflowId,
      event: {
        type: 'nodeExecution.started',
        data: {
          scopeId: request.scopeId,
          authoredNodeId: request.authoredNodeId,
          nodeInstanceId: request.nodeInstanceId,
          attemptId: request.attemptId,
          attemptOrdinal: request.attemptOrdinal,
        },
      },
    },
  },
  {
    name: 'execution reservation request',
    value: {
      kind: 'reserveExecution',
      attemptId: request.attemptId,
      replyWorkflowId: scopeWorkflowId,
    },
  },
  {
    name: 'scope admission request',
    value: {
      kind: 'scopeAdmission',
      requestId: startFence.requestId,
      workflowId: childWorkflowId,
      parentWorkflowId: scopeWorkflowId,
    },
  },
  {
    name: 'root scope readiness',
    value: { kind: 'scopeReady', workflowId: scopeWorkflowId, parentWorkflowId: runWorkflowId },
  },
  {
    name: 'child scope readiness',
    value: {
      kind: 'scopeReady',
      requestId: startFence.requestId,
      admissionId: startFence.admissionId,
      workflowId: childWorkflowId,
      parentWorkflowId: scopeWorkflowId,
    },
  },
  {
    name: 'scope boundary',
    value: { kind: 'scopeBoundary', workflowId: scopeWorkflowId, boundaryId: 'boundary-1' },
  },
  { name: 'scope finish', value: { kind: 'scopeFinish', workflowId: scopeWorkflowId } },
  { name: 'scope settlement', value: { kind: 'scopeSettled', workflowId: scopeWorkflowId } },
  {
    name: 'join scope cancellation',
    value: {
      kind: 'scopeCancellation',
      workflowId: scopeWorkflowId,
      joinNodeInstanceId: request.nodeInstanceId,
      childWorkflowIds: [childWorkflowId],
    },
  },
  {
    name: 'unknown outcome waiter',
    value: {
      kind: 'unknownOutcomeWaiting',
      workflowId: scopeWorkflowId,
      request,
      attemptOrdinal: request.attemptOrdinal,
      reconciliationRound: 1,
      recovery: {
        reconciliation: 'required',
        maximumAttempts: 1,
        timeoutMs: 1_000,
        unknownOutcome: 'fail',
      },
    },
  },
  {
    name: 'run command',
    value: {
      commandId,
      command: {
        kind: 'cancelRun',
        input: { runId: request.runId, actorId: 'operator' },
      },
    },
  },
] as const;

describe('RR-08 durable schema assurance', () => {
  it.each([
    { name: 'execute selection', value: selection },
    { name: 'reconcile selection', value: { ...selection, mode: 'reconcile' } },
  ])('accepts RunNodeEffectSelectionSchema vector: $name', ({ value }) => {
    expect(parseRunNodeEffectSelection(value)).toEqual(value);
  });

  it.each([
    { name: 'completed result', value: branchResult },
    { name: 'cancelled result', value: { status: 'cancelled', key: 'review' } },
  ])('accepts ParallelBranchResultSchema vector: $name', ({ value }) => {
    expect(parseParallelBranchResult(value)).toEqual(value);
  });

  it.each([
    { name: 'execute branch with start fence', value: branchInput },
    {
      name: 'settlement-only branch with parent fence',
      value: {
        ...branchInput,
        disposition: 'settlementOnly',
        startFence: {
          ...startFence,
          directive: 'startCancelled',
          cancellation: { source: 'parent', id: scopeWorkflowId },
        },
      },
    },
  ])('accepts ParallelBranchWorkflowInputSchema vector: $name', ({ value }) => {
    expect(parseParallelBranchWorkflowInput(value)).toEqual(value);
  });

  it.each([
    { name: 'cancel decision', value: joinDecision },
    {
      name: 'drain decision',
      value: { ...joinDecision, remaining: 'drain', skippedBranchKeys: [] },
    },
  ])('accepts DurableParallelJoinDecisionSchema vector: $name', ({ value }) => {
    expect(parseDurableParallelJoinDecision(value)).toEqual(value);
  });

  it.each(coordinatorMessages)('accepts RunCoordinatorMessageSchema vector: $name', ({ value }) => {
    expect(parseRunCoordinatorMessage(value)).toEqual(value);
  });

  it.each([
    { name: 'granted reservation', value: { attemptId: request.attemptId, granted: true } },
    { name: 'denied reservation', value: { attemptId: request.attemptId, granted: false } },
  ])('accepts ExecutionReservationSchema vector: $name', ({ value }) => {
    expect(parseExecutionReservation(value)).toEqual(value);
  });

  it.each([
    { name: 'start', value: startFence },
    {
      name: 'join-decision cancellation',
      value: {
        ...startFence,
        directive: 'startCancelled',
        cancellation: { source: 'joinDecision', id: request.nodeInstanceId },
      },
    },
    {
      name: 'parent cancellation',
      value: {
        ...startFence,
        directive: 'startCancelled',
        cancellation: { source: 'parent', id: scopeWorkflowId },
      },
    },
    {
      name: 'run cancellation',
      value: {
        ...startFence,
        directive: 'startCancelled',
        cancellation: { source: 'run', id: commandId },
      },
    },
  ])('accepts ScopeStartFenceReplySchema vector: $name', ({ value }) => {
    expect(parseScopeStartFenceReply(value)).toEqual(value);
  });

  it.each([
    {
      name: 'malformed nested request input',
      value: {
        ...selection,
        request: { ...selection.request, input: { payload: { kind: 'json' } } },
      },
    },
    { name: 'additional property', value: { ...selection, unexpected: true } },
    {
      name: 'identifier grammar',
      value: { ...selection, request: { ...selection.request, pipelineId: 'not valid' } },
    },
  ])('rejects RunNodeEffectSelectionSchema vector: $name', ({ value }) => {
    expect(() => parseRunNodeEffectSelection(value)).toThrow(
      'Stored node effect selection is invalid.',
    );
  });

  it.each([
    {
      name: 'malformed nested output',
      value: {
        ...branchResult,
        outputs: [['main/review', { result: { kind: 'json' } }]],
      },
    },
    { name: 'additional property', value: { ...branchResult, unexpected: true } },
    { name: 'identifier grammar', value: { ...branchResult, key: 'not valid' } },
  ])('rejects ParallelBranchResultSchema vector: $name', ({ value }) => {
    expect(() => parseParallelBranchResult(value)).toThrow(
      'Parallel branch workflow result is invalid.',
    );
  });

  it.each([
    {
      name: 'malformed nested start fence',
      value: {
        ...branchInput,
        startFence: {
          ...startFence,
          directive: 'startCancelled',
          cancellation: { source: 'parent' },
        },
      },
    },
    { name: 'additional property', value: { ...branchInput, unexpected: true } },
    { name: 'identifier grammar', value: { ...branchInput, branchKey: 'not valid' } },
    { name: 'scope identity grammar', value: { ...branchInput, scopeId: 'sc1_too-short' } },
  ])('rejects ParallelBranchWorkflowInputSchema vector: $name', ({ value }) => {
    expect(() => parseParallelBranchWorkflowInput(value)).toThrow(
      'Parallel branch workflow input is invalid.',
    );
  });

  it.each([
    {
      name: 'malformed nested settlement',
      value: { ...joinDecision, settlements: [{ key: 'winner' }] },
    },
    { name: 'additional property', value: { ...joinDecision, unexpected: true } },
    {
      name: 'identifier grammar',
      value: {
        ...joinDecision,
        settlements: [{ key: 'not valid', outcome: 'completed' }],
      },
    },
    {
      name: 'node identity grammar',
      value: { ...joinDecision, nodeInstanceId: 'ni1_too-short' },
    },
  ])('rejects DurableParallelJoinDecisionSchema vector: $name', ({ value }) => {
    expect(() => parseDurableParallelJoinDecision(value)).toThrow(
      'Stored parallel join decision is invalid.',
    );
  });

  it.each([
    {
      name: 'malformed nested event identity',
      value: {
        ...coordinatorMessages[0].value,
        event: {
          ...coordinatorMessages[0].value.event,
          data: { ...coordinatorMessages[0].value.event.data, attemptOrdinal: 0 },
        },
      },
    },
    {
      name: 'additional property',
      value: { ...coordinatorMessages[0].value, unexpected: true },
    },
    {
      name: 'identifier grammar',
      value: {
        kind: 'scopeCancellation',
        workflowId: scopeWorkflowId,
        joinNodeInstanceId: 'ni1_too-short',
        childWorkflowIds: [childWorkflowId],
      },
    },
  ])('rejects RunCoordinatorMessageSchema vector: $name', ({ value }) => {
    expect(() => parseRunCoordinatorMessage(value)).toThrow('Run coordinator message is invalid.');
  });

  it.each([
    {
      name: 'additional property',
      value: { attemptId: request.attemptId, granted: true, unexpected: true },
    },
    { name: 'identifier grammar', value: { attemptId: 'at1_too-short', granted: true } },
  ])('rejects ExecutionReservationSchema vector: $name', ({ value }) => {
    expect(() => parseExecutionReservation(value)).toThrow('Execution reservation is invalid.');
  });

  it.each([
    {
      name: 'malformed nested cancellation',
      value: {
        ...startFence,
        directive: 'startCancelled',
        cancellation: { source: 'parent' },
      },
    },
    { name: 'additional property', value: { ...startFence, unexpected: true } },
    {
      name: 'identifier grammar',
      value: { ...startFence, workflowId: 'rr:scope:sc1_too-short' },
    },
  ])('rejects ScopeStartFenceReplySchema vector: $name', ({ value }) => {
    expect(() => parseScopeStartFenceReply(value)).toThrow('Scope start fence reply is invalid.');
  });
});
