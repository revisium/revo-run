import type { ScriptEvent } from '@revisium/revo-scripts';

import type { JsonObject, JsonValue } from './json.js';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'recovery_required'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type RunTerminal =
  | Readonly<{ readonly kind: 'succeeded'; readonly outcome: string; readonly output: JsonValue }>
  | Readonly<{ readonly kind: 'failed'; readonly error: RunPublicFailure }>
  | Readonly<{ readonly kind: 'cancelled'; readonly reasonCode: string }>;

export interface RunPublicFailure {
  readonly code: string;
  readonly message: string;
  readonly path: string | null;
  readonly details: JsonObject | null;
}

export interface RunSnapshot {
  readonly schemaVersion: 'run-snapshot/v1';
  readonly runId: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminal: RunTerminal | null;
}

export interface RunActivitySnapshot {
  readonly operationId: string;
  readonly kind: 'agent' | 'script';
  readonly requirementKey: string;
  readonly status:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'recovery_required';
  readonly output: JsonValue | null;
  readonly failure: RunPublicFailure | null;
}

export interface RunOperationSnapshot {
  readonly operationId: string;
  readonly kind: 'agent' | 'script' | 'durationWait' | 'signalWait' | 'humanGate';
  readonly status:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'recovery_required';
  readonly openedAt: string;
  readonly updatedAt: string;
}

export interface RunAttemptSnapshot {
  readonly attemptId: string;
  readonly operationId: string;
  readonly executor: 'agent' | 'script';
  readonly ordinal: number;
  readonly status:
    | 'pending'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'timed_out'
    | 'unknown';
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failure: RunPublicFailure | null;
}

export interface RunWaitSnapshot {
  readonly waitId: string;
  readonly operationId: string;
  readonly kind: 'duration' | 'signal';
  readonly status: 'pending' | 'completed' | 'cancelled';
  readonly signal: string | null;
  readonly openedAt: string;
  readonly deadlineAt: string | null;
}

export interface RunGateSnapshot {
  readonly gateId: string;
  readonly operationId: string;
  readonly status: 'pending' | 'answered' | 'deadline' | 'cancelled';
  readonly subject: string;
  readonly answers: readonly string[];
  readonly openedAt: string;
  readonly deadlineAt: string | null;
  readonly resolution:
    | Readonly<{
        readonly kind: 'answer';
        readonly answer: string;
        readonly actorId: string;
        readonly payload: JsonValue | null;
      }>
    | Readonly<{ readonly kind: 'deadline' }>
    | Readonly<{ readonly kind: 'cancelled' }>
    | null;
}

export interface RunDetails extends Omit<RunSnapshot, 'schemaVersion'> {
  readonly schemaVersion: 'run-details/v1';
  readonly activities: readonly RunActivitySnapshot[];
  readonly operations: readonly RunOperationSnapshot[];
  readonly attempts: readonly RunAttemptSnapshot[];
  readonly waits: readonly RunWaitSnapshot[];
  readonly gates: readonly RunGateSnapshot[];
  readonly recovery: readonly Readonly<{
    readonly operationId: string;
    readonly attemptId: string;
    readonly executor: 'agent' | 'script';
    readonly reasonCode: 'outcome_unknown' | 'reconciliation_failed';
    readonly since: string;
  }>[];
}

export type RunEventPayload =
  | Readonly<{ readonly type: 'run.admitted' }>
  | Readonly<{ readonly type: 'run.started' }>
  | Readonly<{
      readonly type: 'run.status_changed';
      readonly from: RunStatus;
      readonly to: RunStatus;
    }>
  | Readonly<{ readonly type: 'run.terminal'; readonly terminal: RunTerminal }>
  | Readonly<{
      readonly type: 'activity.operation_created';
      readonly activity: RunActivitySnapshot;
    }>
  | Readonly<{
      readonly type: 'activity.operation_finished';
      readonly activity: RunActivitySnapshot;
    }>
  | Readonly<{ readonly type: 'activity.attempt_started'; readonly attempt: RunAttemptSnapshot }>
  | Readonly<{ readonly type: 'activity.attempt_finished'; readonly attempt: RunAttemptSnapshot }>
  | Readonly<{
      readonly type: 'activity.recovery_required';
      readonly recovery: RunDetails['recovery'][number];
    }>
  | Readonly<{
      readonly type: 'script.event';
      readonly operationId: string;
      readonly attemptId: string;
      readonly emissionOrdinal: number;
      readonly event: ScriptEvent;
    }>
  | Readonly<{ readonly type: 'wait.opened'; readonly wait: RunWaitSnapshot }>
  | Readonly<{ readonly type: 'wait.resolved'; readonly wait: RunWaitSnapshot }>
  | Readonly<{ readonly type: 'gate.opened'; readonly gate: RunGateSnapshot }>
  | Readonly<{ readonly type: 'gate.resolved'; readonly gate: RunGateSnapshot }>
  | Readonly<{ readonly type: 'run.cancellation_requested'; readonly actorId: string }>
  | Readonly<{ readonly type: 'run.cancellation_acknowledged'; readonly operationId: string }>;

export interface RunEvent {
  readonly schemaVersion: 'run-event/v1';
  readonly runId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly occurredAt: string;
  readonly payload: RunEventPayload;
}

export interface RunEventPage {
  readonly items: readonly RunEvent[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface RunPage {
  readonly items: readonly RunSnapshot[];
  readonly nextOffset: number | null;
}
