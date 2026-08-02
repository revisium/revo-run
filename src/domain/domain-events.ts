import type { AttemptCorrelation } from './attempt-correlation.js';
import type { AttemptTransitionPayload } from './attempt-transition-payload.js';
import type { Attempt } from './attempt.js';
import type { NodeCorrelation } from './node-correlation.js';
import type { NodeTransitionCause } from './node-transition-cause.js';
import type { RunEventIntent } from './run-event-intent.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunNodeStatus } from './run-node-status.js';
import type { RunOutput } from './run-output.js';
import type { Run } from './run.js';

const nodeCorrelation = (node: RunNodeInstance): NodeCorrelation =>
  Object.freeze({
    activationId: node.activationId,
    kind: 'node',
    nodeInstanceId: node.id,
  });

const attemptCorrelation = (node: RunNodeInstance, attempt: Attempt): AttemptCorrelation =>
  Object.freeze({
    activationId: node.activationId,
    attemptId: attempt.id,
    kind: 'attempt',
    nodeInstanceId: node.id,
  });

const activated = (node: RunNodeInstance): RunEventIntent => {
  if (
    node.status !== 'ready' &&
    node.status !== 'gate_waiting' &&
    node.status !== 'join_waiting' &&
    node.status !== 'selector_waiting' &&
    node.status !== 'succeeded'
  ) {
    throw new TypeError('Only waiting or ready nodes can be activated.');
  }
  return Object.freeze({
    correlation: nodeCorrelation(node),
    kind: 'node.activated',
    payload: Object.freeze({
      activationKey: node.activationKey,
      branchKey: node.branchKey,
      forkScopeKey: node.forkScopeKey,
      iteration: node.iteration,
      nodeKey: node.nodeKey,
      status: node.status,
    }),
    runId: node.runId,
  });
};

const attemptCreated = (node: RunNodeInstance, attempt: Attempt): RunEventIntent =>
  Object.freeze({
    correlation: attemptCorrelation(node, attempt),
    kind: 'attempt.created',
    payload: Object.freeze({
      fencingToken: attempt.fencingToken,
      managerIncarnationId: attempt.managerIncarnationId,
      ordinal: attempt.ordinal,
      status: 'claimed',
    }),
    runId: node.runId,
  });

const attemptTransitioned = (
  node: RunNodeInstance,
  attempt: Attempt,
  payload: AttemptTransitionPayload,
): RunEventIntent =>
  Object.freeze({
    correlation: attemptCorrelation(node, attempt),
    kind: 'attempt.transitioned',
    payload: Object.freeze(payload),
    runId: node.runId,
  });

const nodeTransitioned = (
  node: RunNodeInstance,
  from: RunNodeStatus,
  cause: NodeTransitionCause,
): RunEventIntent =>
  Object.freeze({
    correlation: nodeCorrelation(node),
    kind: 'node.transitioned',
    payload: Object.freeze({ cause, from, to: node.status }),
    runId: node.runId,
  });

const outputRecorded = (output: RunOutput): RunEventIntent =>
  Object.freeze({
    correlation: output.correlation,
    kind: 'output.recorded',
    payload: Object.freeze({
      name: output.name,
      outputId: output.id,
      payloadKind: output.payload.kind,
    }),
    runId: output.runId,
  });

const cancellationRequested = (run: Run): RunEventIntent =>
  Object.freeze({
    correlation: Object.freeze({ kind: 'run' }),
    kind: 'run.transitioned',
    payload: Object.freeze({
      cause: 'cancellation_requested',
      from: 'running',
      to: 'cancelling',
    }),
    runId: run.id,
  });

const terminalized = (
  run: Run,
  terminal: { readonly nodeKey: string; readonly outcome: string },
): RunEventIntent => {
  if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled') {
    throw new TypeError('Only a terminal Run can emit a terminal event.');
  }
  return Object.freeze({
    correlation: Object.freeze({ kind: 'run' }),
    kind: 'run.terminalized',
    payload: Object.freeze({
      fault: run.terminalFault,
      nodeKey: terminal.nodeKey,
      outcome: terminal.outcome,
      status: run.status,
    }),
    runId: run.id,
  });
};

export const domainEvents = Object.freeze({
  activated,
  attemptCreated,
  attemptTransitioned,
  cancellationRequested,
  nodeTransitioned,
  outputRecorded,
  terminalized,
});
