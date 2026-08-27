import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  advancePipeline,
  type PipelineCommand,
  type PipelineEvent,
  type PipelineState,
} from '@revisium/revo-pipeline/kernel';
import type {
  AttemptCancellationResult,
  ScriptAttemptInput,
  ScriptAttemptResult,
  ScriptReconciliationResult,
  ScriptTerminalAttemptResult,
} from '@revisium/revo-scripts';
import {
  AttemptCancellationResultSchema,
  ScriptAttemptResultSchema,
  ScriptEventSchema,
  ScriptReconciliationResultSchema,
} from '@revisium/revo-scripts';
import { Check } from 'typebox/value';

import { isAgentInvocationResult } from '../composition/agent-invocation-result.js';
import type { AgentInvocationResult } from '../composition/agent-port.js';
import { unavailableAgentPort } from '../composition/agent-port.js';
import { requireRunComposition, type RunComposition } from '../composition/run-composition.js';
import type { AdmittedRunSnapshotV1 } from '../contracts/admitted-run.js';
import type { JsonValue } from '../contracts/json.js';
import {
  normalizeAgentFailure,
  normalizeScriptFailure,
  pipelineFailure,
} from '../contracts/normalize-run-public-failure.js';
import type {
  RunActivitySnapshot,
  RunAttemptSnapshot,
  RunDetails,
  RunEvent,
  RunEventPayload,
  RunGateSnapshot,
  RunOperationSnapshot,
  RunPublicFailure,
  RunSnapshot,
  RunStatus,
  RunTerminal,
  RunWaitSnapshot,
} from '../contracts/observation.js';
import {
  RunDetailsSchema,
  RunEventSchema,
  RunSnapshotSchema,
} from '../contracts/public-schemas.js';
import {
  attemptId,
  eventReceiptId,
  gateId,
  operationReceiptId,
  operationId,
  recoveryReceiptId,
  retryStartReceiptId,
  waitId,
} from '../operations/identities.js';
import {
  arbitrateAttemptDispatch,
  attemptDispatchArbitrationCandidate,
} from './attempt-dispatch-arbitration.js';
import {
  gateConfigurationKey,
  runEventHighWaterKey,
  signalWaitConfigurationKey,
  type GateConfigurationV1,
  type SignalWaitConfigurationV1,
} from './interaction-records.js';
import {
  coordinatorTopic,
  operationInteractionTopic,
  operationOutboxKey,
  registeredRunOperationWorkflow,
  type OperationOutboxRecordV1,
  type OperationRecoveryRelayV1,
  type OperationRetryStartRelayV1,
  type RunCoordinatorMessage,
  type ScriptEventRelayV1,
} from './operation-workflow.js';
import { operationWorkflowId } from './workflow-id.js';

export const kernelRunWorkflowName = 'revo-run.kernel-host/v1';
const eventStream = 'revo-run.events';
export interface KernelRunResult {
  readonly snapshot: RunSnapshot;
  readonly details: RunDetails;
}

class RunJournal {
  private sequence = 0;
  private status: RunStatus = 'pending';
  private terminal: RunTerminal | null = null;
  private updatedAt: string;
  private readonly activities: RunActivitySnapshot[] = [];
  private readonly operations: RunOperationSnapshot[] = [];
  private readonly attempts: RunAttemptSnapshot[] = [];
  private readonly waits: RunWaitSnapshot[] = [];
  private readonly gates: RunGateSnapshot[] = [];
  private readonly recovery: {
    operationId: string;
    attemptId: string;
    executor: 'agent' | 'script';
    reasonCode: 'outcome_unknown' | 'reconciliation_failed';
    since: string;
  }[] = [];

  constructor(
    private readonly runId: string,
    private readonly createdAt: string,
  ) {
    this.updatedAt = createdAt;
  }

  async emit(payload: RunEventPayload): Promise<void> {
    this.sequence += 1;
    const occurredAt = new Date(await DBOS.now()).toISOString();
    const event: RunEvent = {
      schemaVersion: 'run-event/v1',
      runId: this.runId,
      sequence: this.sequence,
      cursor: `${this.runId}:${this.sequence}`,
      occurredAt,
      payload,
    };
    if (!Check(RunEventSchema, event)) {
      throw new Error('Run journal event violates the public contract.');
    }
    await DBOS.writeStream(eventStream, event);
    await DBOS.setEvent(runEventHighWaterKey, this.sequence);
    this.updatedAt = occurredAt;
  }

  async setStatus(status: RunStatus): Promise<void> {
    if (status !== this.status) {
      const previous = this.status;
      this.status = status;
      await this.emit({ type: 'run.status_changed', from: previous, to: status });
    }
  }

  async finish(terminal: RunTerminal): Promise<void> {
    this.terminal = terminal;
    await this.setStatus(terminal.kind === 'succeeded' ? 'succeeded' : terminal.kind);
    await this.emit({ type: 'run.terminal', terminal });
  }

  addAttempt(activity: RunActivitySnapshot, attempt: RunAttemptSnapshot): void {
    this.activities.push(activity);
    this.attempts.push(attempt);
    this.operations.push({
      operationId: activity.operationId,
      kind: activity.kind,
      status: 'running',
      openedAt: attempt.startedAt ?? this.updatedAt,
      updatedAt: attempt.startedAt ?? this.updatedAt,
    });
  }

  scheduleRetryAttempt(currentOperationId: string, ordinal: number): RunAttemptSnapshot {
    const existing = this.attempts.find(
      (candidate) => candidate.operationId === currentOperationId && candidate.ordinal === ordinal,
    );
    if (existing !== undefined) {
      return existing;
    }
    const previous = this.attempts
      .filter((candidate) => candidate.operationId === currentOperationId)
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .at(-1);
    const activity = this.activities.find(
      (candidate) => candidate.operationId === currentOperationId,
    );
    const operation = this.operations.find(
      (candidate) => candidate.operationId === currentOperationId,
    );
    if (previous?.ordinal !== ordinal - 1 || activity === undefined || operation === undefined) {
      throw new Error('Retry attempt has no contiguous operation history.');
    }
    const attempt: RunAttemptSnapshot = {
      attemptId: attemptId(currentOperationId, ordinal),
      operationId: currentOperationId,
      executor: 'script',
      ordinal,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      failure: null,
    };
    this.attempts.push(attempt);
    Object.assign(activity, { status: 'running', output: null, failure: null });
    Object.assign(operation, { status: 'running' });
    return attempt;
  }

  startRetryAttempt(
    currentOperationId: string,
    ordinal: number,
    startedAt: string,
  ): RunAttemptSnapshot | null {
    const attempt = this.scheduleRetryAttempt(currentOperationId, ordinal);
    if (attempt.status === 'running' || attempt.status === 'unknown') {
      return null;
    }
    if (attempt.status !== 'pending') {
      throw new Error('Retry start relay cannot reactivate a terminal attempt.');
    }
    Object.assign(attempt, { status: 'running', startedAt });
    const operation = this.operations.find(
      (candidate) => candidate.operationId === currentOperationId,
    );
    if (operation === undefined) {
      throw new Error('Retry attempt has no operation history.');
    }
    Object.assign(operation, { status: 'running', updatedAt: startedAt });
    return attempt;
  }

  activeAttemptOrdinal(currentOperationId: string): number {
    const attempt = this.attempts
      .filter(
        (candidate) =>
          candidate.operationId === currentOperationId &&
          (candidate.status === 'pending' || candidate.status === 'running'),
      )
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (attempt === undefined) {
      throw new Error('Active script cancellation has no running attempt.');
    }
    return attempt.ordinal;
  }

  hasRunningAttempt(
    currentOperationId: string,
    currentAttemptId: string,
    ordinal: number,
  ): boolean {
    return this.attempts.some(
      (candidate) =>
        candidate.operationId === currentOperationId &&
        candidate.attemptId === currentAttemptId &&
        candidate.ordinal === ordinal &&
        candidate.status === 'running',
    );
  }

  finishAttempt(
    finishedOperationId: string,
    finishedAttemptId: string,
    status: Extract<
      RunAttemptSnapshot['status'],
      'succeeded' | 'failed' | 'cancelled' | 'timed_out'
    >,
    output: JsonValue | null,
    failure: RunPublicFailure | null,
    finishedAt: string,
    preserveOperation = false,
  ): void {
    const activity = this.activities.find(
      (candidate) => candidate.operationId === finishedOperationId,
    );
    const attempt = this.attempts.find((candidate) => candidate.attemptId === finishedAttemptId);
    const operation = this.operations.find(
      (candidate) => candidate.operationId === finishedOperationId,
    );
    if (activity === undefined || attempt === undefined || operation === undefined) {
      throw new Error('Attempt completion has no matching journal intent.');
    }
    Object.assign(attempt, {
      status,
      finishedAt,
      failure: status === 'failed' || status === 'timed_out' ? failure : null,
    });
    if (!preserveOperation) {
      const operationStatus = status === 'timed_out' ? 'failed' : status;
      Object.assign(activity, {
        status: operationStatus,
        output: status === 'succeeded' ? output : null,
        failure: status === 'failed' || status === 'timed_out' ? failure : null,
      });
      Object.assign(operation, { status: operationStatus, updatedAt: finishedAt });
    }
    this.dropRecovery(finishedOperationId, finishedAttemptId);
  }

  addWait(wait: RunWaitSnapshot): void {
    this.waits.push(wait);
    this.operations.push({
      operationId: wait.operationId,
      kind: wait.kind === 'duration' ? 'durationWait' : 'signalWait',
      status: 'running',
      openedAt: wait.openedAt,
      updatedAt: wait.openedAt,
    });
  }

  resolveWait(
    resolvedWaitId: string,
    status: Extract<RunWaitSnapshot['status'], 'completed' | 'cancelled'>,
    updatedAt: string,
  ): void {
    const wait = this.waits.find((candidate) => candidate.waitId === resolvedWaitId);
    if (wait === undefined) {
      throw new Error('Wait completion has no matching journal intent.');
    }
    const operation = this.operations.find(
      (candidate) => candidate.operationId === wait.operationId,
    );
    if (operation === undefined) {
      throw new Error('Wait completion has no matching operation intent.');
    }
    Object.assign(wait, { status });
    Object.assign(operation, {
      status: status === 'completed' ? 'succeeded' : 'cancelled',
      updatedAt,
    });
  }

  addGate(gate: RunGateSnapshot): void {
    this.gates.push(gate);
    this.operations.push({
      operationId: gate.operationId,
      kind: 'humanGate',
      status: 'running',
      openedAt: gate.openedAt,
      updatedAt: gate.openedAt,
    });
  }

  resolveGate(
    resolvedGateId: string,
    resolution: Exclude<RunGateSnapshot['resolution'], null>,
    updatedAt: string,
  ): void {
    const gate = this.gates.find((candidate) => candidate.gateId === resolvedGateId);
    if (gate === undefined) {
      throw new Error('Gate completion has no matching journal intent.');
    }
    const operation = this.operations.find(
      (candidate) => candidate.operationId === gate.operationId,
    );
    if (operation === undefined) {
      throw new Error('Gate completion has no matching operation intent.');
    }
    const status = resolution.kind === 'answer' ? 'answered' : resolution.kind;
    Object.assign(gate, { status, resolution });
    Object.assign(operation, {
      status: status === 'cancelled' ? 'cancelled' : 'succeeded',
      updatedAt,
    });
  }

  markRecovery(
    operation: string,
    attempt: string,
    since: string,
    reasonCode: 'outcome_unknown' | 'reconciliation_failed' = 'outcome_unknown',
  ): boolean {
    const activity = this.activities.find((candidate) => candidate.operationId === operation);
    const attemptSnapshot = this.attempts.find((candidate) => candidate.attemptId === attempt);
    const operationSnapshot = this.operations.find(
      (candidate) => candidate.operationId === operation,
    );
    if (
      activity === undefined ||
      attemptSnapshot === undefined ||
      operationSnapshot === undefined
    ) {
      throw new Error('Recovery observation has no matching journal intent.');
    }
    Object.assign(activity, { status: 'recovery_required', output: null, failure: null });
    Object.assign(attemptSnapshot, { status: 'unknown', finishedAt: null, failure: null });
    Object.assign(operationSnapshot, { status: 'recovery_required', updatedAt: since });
    const nextRecovery = {
      operationId: operation,
      attemptId: attempt,
      executor: attemptSnapshot.executor,
      reasonCode,
      since,
    } as const;
    const existing = this.recovery.findIndex(
      (candidate) =>
        candidate.operationId === nextRecovery.operationId &&
        candidate.attemptId === nextRecovery.attemptId,
    );
    if (existing === -1) {
      this.recovery.push(nextRecovery);
      return true;
    } else {
      this.recovery[existing] = nextRecovery;
      return false;
    }
  }

  hasRecovery(operation: string, attempt: string): boolean {
    return this.recovery.some(
      (candidate) => candidate.operationId === operation && candidate.attemptId === attempt,
    );
  }

  private dropRecovery(operation: string, attempt: string): void {
    const index = this.recovery.findIndex(
      (candidate) => candidate.operationId === operation && candidate.attemptId === attempt,
    );
    if (index !== -1) {
      this.recovery.splice(index, 1);
    }
  }

  result(): KernelRunResult {
    const snapshot: RunSnapshot = Object.freeze({
      schemaVersion: 'run-snapshot/v1',
      runId: this.runId,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      terminal: this.terminal,
    });
    const result = Object.freeze({
      snapshot,
      details: Object.freeze({
        ...snapshot,
        schemaVersion: 'run-details/v1',
        activities: Object.freeze(
          [...this.activities].sort((left, right) =>
            left.operationId.localeCompare(right.operationId),
          ),
        ),
        operations: Object.freeze(
          [...this.operations].sort((left, right) =>
            left.operationId.localeCompare(right.operationId),
          ),
        ),
        attempts: Object.freeze(
          [...this.attempts].sort(
            (left, right) =>
              left.operationId.localeCompare(right.operationId) || left.ordinal - right.ordinal,
          ),
        ),
        waits: Object.freeze(
          [...this.waits].sort((left, right) => left.waitId.localeCompare(right.waitId)),
        ),
        gates: Object.freeze(
          [...this.gates].sort((left, right) => left.gateId.localeCompare(right.gateId)),
        ),
        recovery: Object.freeze(
          [...this.recovery].sort(
            (left, right) =>
              left.operationId.localeCompare(right.operationId) ||
              left.attemptId.localeCompare(right.attemptId),
          ),
        ),
      }),
    });
    if (!Check(RunSnapshotSchema, result.snapshot) || !Check(RunDetailsSchema, result.details)) {
      throw new Error('Run journal projection violates the public contract.');
    }
    return result;
  }

  async publishDetails(): Promise<void> {
    await DBOS.setEvent('revo-run.details', this.result().details);
  }
}

const terminalFor = (command: PipelineCommand): RunTerminal | undefined => {
  if (command.kind === 'complete') {
    return { kind: 'succeeded', outcome: command.outcome, output: command.output };
  }
  if (command.kind === 'fail') {
    return {
      kind: 'failed',
      error: pipelineFailure(command.code),
    };
  }
  if (command.kind === 'cancel') {
    return { kind: 'cancelled', reasonCode: command.reasonCode };
  }
  return undefined;
};

type HostedCommand = Extract<
  PipelineCommand,
  { readonly kind: 'dispatchActivity' | 'scheduleWait' | 'openHumanGate' }
>;

const isHostedCommand = (command: PipelineCommand): command is HostedCommand =>
  command.kind === 'dispatchActivity' ||
  command.kind === 'scheduleWait' ||
  command.kind === 'openHumanGate';

const stageOperation = async (
  snapshot: AdmittedRunSnapshotV1,
  command: HostedCommand,
  journal: RunJournal,
): Promise<string> => {
  const operation = operationId(snapshot.runId, command.key);
  const openedAt = new Date(await DBOS.now()).toISOString();
  if (command.kind === 'dispatchActivity') {
    const requirement = snapshot.compilation.requirements.entries.find(
      (candidate) => candidate.key === command.requirementKey,
    );
    if (requirement?.kind !== 'script' && requirement?.kind !== 'agent') {
      throw new Error('Activity command has no admitted requirement.');
    }
    const attempt = attemptId(operation, 1);
    const activity: RunActivitySnapshot = {
      operationId: operation,
      kind: requirement.kind,
      requirementKey: command.requirementKey,
      status: 'running',
      output: null,
      failure: null,
    };
    const attemptSnapshot: RunAttemptSnapshot = {
      attemptId: attempt,
      operationId: operation,
      executor: requirement.kind,
      ordinal: 1,
      status: 'running',
      startedAt: openedAt,
      finishedAt: null,
      failure: null,
    };
    journal.addAttempt(activity, attemptSnapshot);
    await journal.emit({ type: 'activity.operation_created', activity });
    await journal.emit({ type: 'activity.attempt_started', attempt: attemptSnapshot });
    await journal.publishDetails();
    return operation;
  }
  if (command.kind === 'scheduleWait') {
    const id = waitId(snapshot.runId, command.key);
    const wait: RunWaitSnapshot = {
      waitId: id,
      operationId: operation,
      kind: command.wait.kind,
      status: 'pending',
      signal: command.wait.kind === 'signal' ? command.wait.signal : null,
      openedAt,
      deadlineAt:
        command.wait.kind === 'duration'
          ? new Date(Date.parse(openedAt) + command.wait.durationMs).toISOString()
          : null,
    };
    journal.addWait(wait);
    await journal.emit({ type: 'wait.opened', wait });
    if (command.wait.kind === 'signal') {
      const configuration: SignalWaitConfigurationV1 = {
        schemaVersion: 'run-signal-wait-configuration/v1',
        operationId: operation,
        payloadSchema: command.wait.payloadSchema,
      };
      await DBOS.setEvent(signalWaitConfigurationKey(id), configuration);
    }
    await journal.publishDetails();
    return operation;
  }
  const id = gateId(snapshot.runId, command.key);
  const gate: RunGateSnapshot = {
    gateId: id,
    operationId: operation,
    status: 'pending',
    subject: command.subject,
    answers: command.answers,
    openedAt,
    deadlineAt:
      command.deadline === null
        ? null
        : new Date(Date.parse(openedAt) + command.deadline.afterMs).toISOString(),
    resolution: null,
  };
  journal.addGate(gate);
  await journal.emit({ type: 'gate.opened', gate });
  const configuration: GateConfigurationV1 = {
    schemaVersion: 'run-gate-configuration/v1',
    operationId: operation,
    authorizationRequirements: command.authorizationRequirements,
    payloadSchema: command.payloadSchema,
  };
  await DBOS.setEvent(gateConfigurationKey(id), configuration);
  await journal.publishDetails();
  return operation;
};

const outboxRecord = (
  snapshot: AdmittedRunSnapshotV1,
  operation: string,
  command: HostedCommand,
): OperationOutboxRecordV1 => ({
  schemaVersion: 'run-operation-outbox/v1',
  runId: snapshot.runId,
  operationId: operation,
  command,
});

const drainLiveRelay = async (
  journal: RunJournal,
  runId: string,
  active: ReadonlyMap<string, HostedCommand>,
  relay: ScriptEventRelayV1,
): Promise<void> => {
  const command = active.get(relay.operationId);
  if (
    command?.kind !== 'dispatchActivity' ||
    relay.schemaVersion !== 'script-event-relay/v1' ||
    relay.runId !== runId ||
    !Number.isSafeInteger(relay.attemptOrdinal) ||
    relay.attemptOrdinal < 1 ||
    relay.attemptId !== attemptId(relay.operationId, relay.attemptOrdinal) ||
    !journal.hasRunningAttempt(relay.operationId, relay.attemptId, relay.attemptOrdinal) ||
    !Number.isSafeInteger(relay.emissionOrdinal) ||
    relay.emissionOrdinal < 1 ||
    relay.eventReceiptId !==
      eventReceiptId(runId, relay.operationId, relay.attemptId, relay.emissionOrdinal) ||
    relay.event.name === 'revo.script.succeeded' ||
    relay.event.name === 'revo.script.failed' ||
    relay.event.name === 'revo.script.cancelled' ||
    relay.event.name === 'revo.script.timed_out'
  ) {
    throw new Error('Invalid script live-event relay.');
  }
  const validated = await ScriptEventSchema.validate(relay.event);
  if (!validated.ok) {
    throw new Error('Script live-event relay does not satisfy the owning event schema.');
  }
  await journal.emit({
    type: 'script.event',
    operationId: relay.operationId,
    attemptId: relay.attemptId,
    emissionOrdinal: relay.emissionOrdinal,
    event: relay.event,
  });
};

const terminalEventName = (result: ScriptTerminalAttemptResult): string => {
  switch (result.kind) {
    case 'succeeded':
      return 'revo.script.succeeded';
    case 'failed':
      return 'revo.script.failed';
    case 'cancelled':
      return 'revo.script.cancelled';
    case 'timedOut':
      return 'revo.script.timed_out';
    default:
      result satisfies never;
      throw new Error('Script terminal result has an unsupported kind.');
  }
};

const requireMatchingTerminalEvent = async (
  result: ScriptTerminalAttemptResult,
  ordinal: number,
): Promise<void> => {
  if (result.terminalEvent.event.name !== terminalEventName(result)) {
    throw new Error('Script terminal result has a mismatched sealed terminal event.');
  }
  const validated = await ScriptEventSchema.validate(result.terminalEvent.event);
  if (!validated.ok) {
    throw new Error('Script terminal result has an invalid sealed terminal event.');
  }
  if (result.terminalEvent.event.details.attemptOrdinal !== ordinal) {
    throw new Error('Script terminal result has a mismatched attempt ordinal.');
  }
};

export const deriveScriptTerminalPipelineEvent = (
  command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>,
  result: ScriptTerminalAttemptResult,
): PipelineEvent => {
  if (result.kind === 'succeeded') {
    return {
      kind: 'activitySucceeded',
      commandKey: command.key,
      ref: command.ref,
      output: result.value,
    };
  }
  if (result.kind === 'cancelled') {
    return { kind: 'activityCancelled', commandKey: command.key, ref: command.ref };
  }
  return {
    kind: 'activityFailed',
    commandKey: command.key,
    ref: command.ref,
    errorCode: result.error.code,
  };
};

export const deriveAgentTerminalPipelineEvent = (
  command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>,
  result: AgentInvocationResult,
): PipelineEvent => {
  if (result.status === 'succeeded') {
    if (result.value === undefined) {
      throw new Error('Agent success result is missing its output.');
    }
    return {
      kind: 'activitySucceeded',
      commandKey: command.key,
      ref: command.ref,
      output: result.value,
    };
  }
  if (result.status === 'cancelled') {
    return { kind: 'activityCancelled', commandKey: command.key, ref: command.ref };
  }
  return {
    kind: 'activityFailed',
    commandKey: command.key,
    ref: command.ref,
    errorCode: result.error?.code ?? 'revo.run.execution_failed',
  };
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Operation observation event has a non-JSON number.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => compareCanonicalKeys(left, right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(',')}}`;
  }
  throw new Error('Operation observation event has a non-JSON value.');
};

const compareCanonicalKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export const requireExactPipelineEvent = (actual: PipelineEvent, expected: PipelineEvent): void => {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('Operation observation event does not match its owning terminal result.');
  }
};

const isScriptIdentity = (value: string): value is `script:${string}` =>
  value.startsWith('script:');

const scriptAttemptInput = (
  snapshot: AdmittedRunSnapshotV1,
  command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>,
  operation: string,
  ordinal = 1,
): ScriptAttemptInput => {
  const requirement = snapshot.compilation.requirements.entries.find(
    (candidate) => candidate.key === command.requirementKey,
  );
  const binding = snapshot.bindings.scripts[command.requirementKey];
  const scriptId = requirement?.kind === 'script' ? requirement.script.id : undefined;
  if (
    requirement?.kind !== 'script' ||
    binding === undefined ||
    scriptId === undefined ||
    !isScriptIdentity(scriptId)
  ) {
    throw new Error('Active script cancellation has no admitted binding.');
  }
  return {
    executionId: operation,
    attemptId: attemptId(operation, ordinal),
    attemptOrdinal: ordinal,
    script: { id: scriptId, version: requirement.script.version },
    binding,
    input: command.input,
  };
};

const applyScriptObservation = async (
  journal: RunJournal,
  operation: string,
  ordinal: number,
  result: ScriptAttemptResult,
  retrying = false,
): Promise<'terminal' | 'uncertain'> => {
  const validated = await ScriptAttemptResultSchema.validate(result);
  if (!validated.ok) {
    throw new Error('Script observation does not satisfy the owning result schema.');
  }
  const startedAt = new Date(await DBOS.now()).toISOString();
  const retry = ordinal > 1 ? journal.startRetryAttempt(operation, ordinal, startedAt) : null;
  if (retry !== null) {
    await journal.emit({ type: 'activity.attempt_started', attempt: retry });
  }
  const attempt = attemptId(operation, ordinal);
  if (result.kind === 'uncertain') {
    journal.markRecovery(operation, attempt, new Date(await DBOS.now()).toISOString());
    await journal.setStatus('recovery_required');
    const recovery = journal.result().details.recovery.at(-1);
    if (recovery === undefined) {
      throw new Error('Uncertain script result has no recovery observation.');
    }
    await journal.emit({ type: 'activity.recovery_required', recovery });
    await journal.publishDetails();
    return 'uncertain';
  }
  const terminal: ScriptTerminalAttemptResult = result;
  await requireMatchingTerminalEvent(terminal, ordinal);
  await journal.emit({
    type: 'script.event',
    operationId: operation,
    attemptId: attempt,
    emissionOrdinal: terminal.terminalEvent.emissionOrdinal,
    event: terminal.terminalEvent.event,
  });
  const finishedAt = new Date(await DBOS.now()).toISOString();
  if (terminal.kind === 'succeeded') {
    journal.finishAttempt(
      operation,
      attempt,
      'succeeded',
      terminal.value,
      null,
      finishedAt,
      retrying,
    );
  } else if (terminal.kind === 'cancelled') {
    journal.finishAttempt(operation, attempt, 'cancelled', null, null, finishedAt, retrying);
  } else if (terminal.kind === 'timedOut') {
    journal.finishAttempt(
      operation,
      attempt,
      'timed_out',
      null,
      normalizeScriptFailure(terminal.error),
      finishedAt,
      retrying,
    );
  } else {
    journal.finishAttempt(
      operation,
      attempt,
      'failed',
      null,
      normalizeScriptFailure(terminal.error),
      finishedAt,
      retrying,
    );
  }
  const details = journal.result().details;
  const activity = details.activities.find((candidate) => candidate.operationId === operation);
  const completedAttempt = details.attempts.find((candidate) => candidate.attemptId === attempt);
  if (activity === undefined || completedAttempt === undefined) {
    throw new Error('Script journal completion is unavailable.');
  }
  if (!retrying) {
    await journal.emit({ type: 'activity.operation_finished', activity });
  }
  await journal.emit({ type: 'activity.attempt_finished', attempt: completedAttempt });
  if (retrying) {
    journal.scheduleRetryAttempt(operation, ordinal + 1);
  }
  await journal.publishDetails();
  return 'terminal';
};

const applyScriptPreDispatchCancellation = async (
  journal: RunJournal,
  operation: string,
  ordinal: number,
): Promise<void> => {
  const finishedAt = new Date(await DBOS.now()).toISOString();
  // Cancellation can win while the root has only recorded the pending retry.
  // Keep that pre-dispatch attempt pending until it is atomically settled below;
  // no physical-attempt-start event is truthful in this branch.
  if (ordinal > 1) {
    journal.scheduleRetryAttempt(operation, ordinal);
  }
  const activeAttemptId = attemptId(operation, ordinal);
  journal.finishAttempt(operation, activeAttemptId, 'cancelled', null, null, finishedAt);
  const details = journal.result().details;
  const activity = details.activities.find((candidate) => candidate.operationId === operation);
  const completedAttempt = details.attempts.find(
    (candidate) => candidate.attemptId === activeAttemptId,
  );
  if (activity === undefined || completedAttempt === undefined) {
    throw new Error('Pre-dispatch script cancellation has no journal completion.');
  }
  await journal.emit({ type: 'activity.operation_finished', activity });
  await journal.emit({ type: 'activity.attempt_finished', attempt: completedAttempt });
  await journal.publishDetails();
};

const applyAgentObservation = async (
  journal: RunJournal,
  operation: string,
  attempt: string,
  result: AgentInvocationResult,
): Promise<void> => {
  if (!isAgentInvocationResult(result)) {
    throw new Error('Agent observation does not satisfy the private result contract.');
  }
  const finishedAt = new Date(await DBOS.now()).toISOString();
  if (result.status === 'succeeded') {
    if (result.value === undefined) {
      throw new Error('Agent success result is missing its output.');
    }
    journal.finishAttempt(operation, attempt, 'succeeded', result.value, null, finishedAt);
  } else if (result.status === 'cancelled') {
    journal.finishAttempt(operation, attempt, 'cancelled', null, null, finishedAt);
  } else {
    journal.finishAttempt(
      operation,
      attempt,
      result.status === 'timed_out' ? 'timed_out' : 'failed',
      null,
      normalizeAgentFailure(result.error),
      finishedAt,
    );
  }
  const details = journal.result().details;
  const activity = details.activities.find((candidate) => candidate.operationId === operation);
  const completedAttempt = details.attempts.find((candidate) => candidate.attemptId === attempt);
  if (activity === undefined || completedAttempt === undefined) {
    throw new Error('Agent journal completion is unavailable.');
  }
  await journal.emit({ type: 'activity.operation_finished', activity });
  await journal.emit({ type: 'activity.attempt_finished', attempt: completedAttempt });
  await journal.publishDetails();
};

const applyRecoveryRelay = async (
  journal: RunJournal,
  runId: string,
  active: ReadonlyMap<string, HostedCommand>,
  relay: OperationRecoveryRelayV1,
): Promise<boolean> => {
  const command = active.get(relay.operationId);
  const alreadyRecorded = journal.hasRecovery(relay.operationId, relay.attemptId);
  if (
    relay.runId !== runId ||
    !Number.isSafeInteger(relay.attemptOrdinal) ||
    relay.attemptOrdinal < 1 ||
    relay.observationReceiptId !==
      recoveryReceiptId(runId, relay.operationId, relay.attemptOrdinal) ||
    relay.attemptId !== attemptId(relay.operationId, relay.attemptOrdinal) ||
    (!alreadyRecorded &&
      !journal.hasRunningAttempt(relay.operationId, relay.attemptId, relay.attemptOrdinal)) ||
    (relay.reasonCode !== 'outcome_unknown' && relay.reasonCode !== 'reconciliation_failed') ||
    command?.kind !== 'dispatchActivity' ||
    command.key !== relay.commandKey
  ) {
    throw new Error('Operation recovery relay has an invalid durable receipt.');
  }
  const added = journal.markRecovery(
    relay.operationId,
    relay.attemptId,
    new Date(await DBOS.now()).toISOString(),
    relay.reasonCode,
  );
  await journal.setStatus('recovery_required');
  const recovery = journal.result().details.recovery.at(-1);
  if (recovery === undefined) {
    throw new Error('Operation recovery relay has no journal observation.');
  }
  if (added) {
    await journal.emit({ type: 'activity.recovery_required', recovery });
    await journal.publishDetails();
  }
  return added;
};

const applyRetryStartRelay = async (
  journal: RunJournal,
  runId: string,
  active: ReadonlyMap<string, HostedCommand>,
  relay: OperationRetryStartRelayV1,
): Promise<void> => {
  const command = active.get(relay.operationId);
  if (
    relay.runId !== runId ||
    relay.retryReceiptId !== retryStartReceiptId(runId, relay.operationId, relay.attemptOrdinal) ||
    !Number.isSafeInteger(relay.attemptOrdinal) ||
    relay.attemptOrdinal < 2 ||
    relay.attemptId !== attemptId(relay.operationId, relay.attemptOrdinal) ||
    command?.kind !== 'dispatchActivity' ||
    command.key !== relay.commandKey
  ) {
    throw new Error('Operation retry-start relay has an invalid durable receipt.');
  }
  const attempt = journal.startRetryAttempt(
    relay.operationId,
    relay.attemptOrdinal,
    new Date(await DBOS.now()).toISOString(),
  );
  if (attempt !== null) {
    await journal.emit({ type: 'activity.attempt_started', attempt });
  }
  await journal.publishDetails();
};

const applyInteractionObservation = async (
  journal: RunJournal,
  runId: string,
  command: Exclude<HostedCommand, { readonly kind: 'dispatchActivity' }>,
  event: PipelineEvent,
): Promise<void> => {
  const updatedAt = new Date(await DBOS.now()).toISOString();
  if (command.kind === 'scheduleWait') {
    const id = waitId(runId, command.key);
    if (
      event.kind !== 'waitCompleted' &&
      event.kind !== 'signalReceived' &&
      event.kind !== 'waitCancelled'
    ) {
      throw new Error('Wait operation returned an incompatible pipeline event.');
    }
    journal.resolveWait(id, event.kind === 'waitCancelled' ? 'cancelled' : 'completed', updatedAt);
    const wait = journal.result().details.waits.find((candidate) => candidate.waitId === id);
    if (wait === undefined) {
      throw new Error('Wait journal completion is unavailable.');
    }
    await journal.emit({ type: 'wait.resolved', wait });
    await journal.publishDetails();
    return;
  }
  const id = gateId(runId, command.key);
  if (event.kind === 'gateCancelled') {
    journal.resolveGate(id, { kind: 'cancelled' }, updatedAt);
  } else if (event.kind === 'gateResolved' && event.resolution.kind === 'deadline') {
    journal.resolveGate(id, { kind: 'deadline' }, updatedAt);
  } else if (event.kind === 'gateResolved' && event.resolution.kind === 'answer') {
    journal.resolveGate(
      id,
      {
        kind: 'answer',
        answer: event.resolution.answer,
        actorId: event.resolution.actorRef,
        payload: event.resolution.payload,
      },
      updatedAt,
    );
  } else {
    throw new Error('Human gate operation returned an incompatible pipeline event.');
  }
  const gate = journal.result().details.gates.find((candidate) => candidate.gateId === id);
  if (gate === undefined) {
    throw new Error('Gate journal completion is unavailable.');
  }
  await journal.emit({ type: 'gate.resolved', gate });
  await journal.publishDetails();
};

const advance = async (
  snapshot: AdmittedRunSnapshotV1,
  state: PipelineState,
  event: PipelineEvent,
): Promise<{ readonly state: PipelineState; readonly commands: readonly PipelineCommand[] }> =>
  DBOS.runStep(
    async () => {
      const transition = advancePipeline(
        {
          program: snapshot.compilation.program,
          programDigest: snapshot.compilation.programDigest,
        },
        state,
        event,
      );
      if (transition.kind === 'rejected') {
        throw new Error('Pipeline kernel rejected a durable host event.');
      }
      return { state: transition.state, commands: transition.commands };
    },
    { name: 'kernel.advance' },
  );

const requestCancellationTransition = async (
  snapshot: AdmittedRunSnapshotV1,
  state: PipelineState,
  journal: RunJournal,
  actorId: string,
): Promise<{ readonly state: PipelineState; readonly commands: readonly PipelineCommand[] }> => {
  await journal.setStatus('cancelling');
  await journal.emit({ type: 'run.cancellation_requested', actorId });
  await journal.publishDetails();
  return advance(snapshot, state, { kind: 'cancelRequested', reasonCode: 'run.cancel_requested' });
};

const withoutHandledCancellation = (
  commands: readonly PipelineCommand[],
): readonly PipelineCommand[] => commands.filter((command) => command.kind !== 'cancelPending');

interface KernelWorkflowContext {
  readonly snapshot: AdmittedRunSnapshotV1;
  readonly composition: RunComposition;
  readonly journal: RunJournal;
  readonly rootWorkflowId: string;
  state: PipelineState;
  readonly commands: PipelineCommand[];
  readonly active: Map<string, HostedCommand>;
  readonly recoveryOperations: Set<string>;
  readonly receipts: Set<string>;
  readonly deferredKernelEvents: PipelineEvent[];
  recoveryPending: boolean;
}

type ObservationRelay = Extract<
  RunCoordinatorMessage,
  { readonly schemaVersion: 'operation-observation-relay/v1' }
>;

type ObservationDisposition = 'recovery' | 'retrying' | 'settled';

interface ScriptCancellationContext {
  readonly runtime: KernelWorkflowContext;
  readonly command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>;
  readonly operation: string;
  readonly input: ScriptAttemptInput;
}

const requireCompatibleSnapshot = (snapshot: AdmittedRunSnapshotV1): void => {
  if (
    snapshot.persistenceVersion !== 1 ||
    typeof snapshot.runId !== 'string' ||
    typeof snapshot.admission?.createdAt !== 'string' ||
    typeof snapshot.admission?.token !== 'string' ||
    snapshot.admission.token.length === 0
  ) {
    throw new Error('Run kernel rejected an incompatible admitted snapshot.');
  }
};

const initializeKernelContext = async (
  snapshot: AdmittedRunSnapshotV1,
): Promise<KernelWorkflowContext> => {
  const composition = requireRunComposition();
  await composition.fence.awaitOpen();
  const journal = new RunJournal(snapshot.runId, snapshot.admission.createdAt);
  await journal.emit({ type: 'run.admitted' });
  await journal.setStatus('running');
  await journal.emit({ type: 'run.started' });
  await journal.publishDetails();
  const rootWorkflowId = DBOS.workflowID;
  if (rootWorkflowId === undefined) {
    throw new Error('Run kernel is outside of its root workflow.');
  }
  return {
    snapshot,
    composition,
    journal,
    rootWorkflowId,
    state: snapshot.initial.state,
    commands: [...snapshot.initial.commands],
    active: new Map(),
    recoveryOperations: new Set(),
    receipts: new Set(),
    deferredKernelEvents: [],
    recoveryPending: false,
  };
};

const unavailableAgentCommand = (
  runtime: KernelWorkflowContext,
): Extract<HostedCommand, { readonly kind: 'dispatchActivity' }> | undefined =>
  runtime.commands.find(
    (candidate): candidate is Extract<HostedCommand, { readonly kind: 'dispatchActivity' }> =>
      candidate.kind === 'dispatchActivity' &&
      runtime.snapshot.compilation.requirements.entries.some(
        (requirement) =>
          requirement.kind === 'agent' && requirement.key === candidate.requirementKey,
      ),
  );

const recoverUnavailableAgent = async (
  runtime: KernelWorkflowContext,
): Promise<KernelRunResult | null> => {
  const hasUnavailableAgent =
    runtime.composition.agents === unavailableAgentPort &&
    runtime.snapshot.compilation.requirements.entries.some(
      (requirement) => requirement.kind === 'agent',
    );
  if (!hasUnavailableAgent) {
    return null;
  }
  const command = unavailableAgentCommand(runtime);
  if (command === undefined) {
    await runtime.journal.setStatus('recovery_required');
    await runtime.journal.publishDetails();
  } else {
    const operation = await stageOperation(runtime.snapshot, command, runtime.journal);
    const recoveryAt = new Date(await DBOS.now()).toISOString();
    runtime.journal.markRecovery(operation, attemptId(operation, 1), recoveryAt);
    await runtime.journal.setStatus('recovery_required');
    const recovery = runtime.journal.result().details.recovery.at(-1);
    if (recovery === undefined) {
      throw new Error('Unavailable agent recovery has no journal observation.');
    }
    await runtime.journal.emit({ type: 'activity.recovery_required', recovery });
    await runtime.journal.publishDetails();
  }
  await DBOS.closeStream(eventStream);
  return runtime.journal.result();
};

const dispatchOperation = async (
  runtime: KernelWorkflowContext,
  command: HostedCommand,
): Promise<void> => {
  const operation = await stageOperation(runtime.snapshot, command, runtime.journal);
  await DBOS.setEvent(
    operationOutboxKey(operation),
    outboxRecord(runtime.snapshot, operation, command),
  );
  runtime.active.set(operation, command);
  await DBOS.startWorkflow(registeredRunOperationWorkflow, {
    workflowID: operationWorkflowId(operation),
  })({
    schemaVersion: 'run-operation-workflow-input/v1',
    runId: runtime.snapshot.runId,
    operationId: operation,
    rootWorkflowId: runtime.rootWorkflowId,
  });
};

const sendGenericOperationCancellation = async (operation: string): Promise<void> => {
  await DBOS.send(
    operationWorkflowId(operation),
    { schemaVersion: 'operation-interaction/v1', kind: 'cancel', actorId: 'run-manager' },
    operationInteractionTopic,
    `cancel:${operation}`,
  );
};

const sendScriptTerminalObservation = async (
  context: ScriptCancellationContext,
  result: ScriptTerminalAttemptResult,
): Promise<void> => {
  const { command, input, operation, runtime } = context;
  await requireMatchingTerminalEvent(result, input.attemptOrdinal);
  const receipt = operationReceiptId(runtime.snapshot.runId, operation, input.attemptOrdinal);
  await DBOS.send(
    runtime.rootWorkflowId,
    {
      schemaVersion: 'operation-observation-relay/v1',
      observationReceiptId: receipt,
      runId: runtime.snapshot.runId,
      operationId: operation,
      commandKey: command.key,
      attemptOrdinal: input.attemptOrdinal,
      retrying: false,
      event: deriveScriptTerminalPipelineEvent(command, result),
      scriptResult: result,
      agentResult: null,
      preDispatchCancelled: false,
    },
    coordinatorTopic,
    receipt,
  );
};

const sendScriptPreDispatchCancellation = async (
  context: ScriptCancellationContext,
): Promise<void> => {
  const { command, input, operation, runtime } = context;
  const receipt = operationReceiptId(runtime.snapshot.runId, operation, input.attemptOrdinal);
  await DBOS.send(
    runtime.rootWorkflowId,
    {
      schemaVersion: 'operation-observation-relay/v1',
      observationReceiptId: receipt,
      runId: runtime.snapshot.runId,
      operationId: operation,
      commandKey: command.key,
      attemptOrdinal: input.attemptOrdinal,
      retrying: false,
      event: { kind: 'activityCancelled', commandKey: command.key, ref: command.ref },
      scriptResult: null,
      agentResult: null,
      preDispatchCancelled: true,
    },
    coordinatorTopic,
    receipt,
  );
};

const recordScriptCancellationRecovery = async (
  context: ScriptCancellationContext,
  reasonCode: 'outcome_unknown' | 'reconciliation_failed' = 'outcome_unknown',
): Promise<void> => {
  const { input, operation, runtime } = context;
  runtime.journal.markRecovery(
    operation,
    input.attemptId,
    new Date(await DBOS.now()).toISOString(),
    reasonCode,
  );
  await runtime.journal.setStatus('recovery_required');
  const recovery = runtime.journal.result().details.recovery.at(-1);
  if (recovery === undefined) {
    throw new Error('Script cancellation has no recovery observation.');
  }
  await runtime.journal.emit({ type: 'activity.recovery_required', recovery });
  await runtime.journal.publishDetails();
  runtime.recoveryOperations.add(operation);
  runtime.recoveryPending = true;
};

const reconcileScriptCancellation = async (context: ScriptCancellationContext): Promise<void> => {
  let reconciliation: ScriptReconciliationResult;
  try {
    reconciliation = await DBOS.runStep(
      async (): Promise<ScriptReconciliationResult> => {
        const raw = await context.runtime.composition.scripts.reconcileAttempt(context.input, {
          signal: new AbortController().signal,
        });
        const validated = await ScriptReconciliationResultSchema.validate(raw);
        if (!validated.ok) {
          throw new Error('Script cancellation reconciliation is invalid.');
        }
        return raw;
      },
      { name: `script-cancel-reconcile:${context.input.attemptId}`, retriesAllowed: false },
    );
  } catch {
    await recordScriptCancellationRecovery(context, 'reconciliation_failed');
    return;
  }
  if (reconciliation.kind === 'terminal') {
    await sendScriptTerminalObservation(context, reconciliation.result);
    return;
  }
  await recordScriptCancellationRecovery(context);
};

const scriptCancellationResult = async (
  context: ScriptCancellationContext,
): Promise<AttemptCancellationResult> =>
  DBOS.runStep(
    async (): Promise<AttemptCancellationResult> => {
      try {
        const raw = await context.runtime.composition.scripts.cancelAttempt(
          { executionId: context.input.executionId, attemptId: context.input.attemptId },
          { signal: new AbortController().signal },
        );
        const validated = await AttemptCancellationResultSchema.validate(raw);
        return validated.ok ? raw : { kind: 'unknown' };
      } catch {
        return { kind: 'unknown' };
      }
    },
    { name: `script-cancel:${context.input.attemptId}`, retriesAllowed: false },
  );

const applyScriptCancellationResult = async (
  context: ScriptCancellationContext,
  cancellation: AttemptCancellationResult,
): Promise<void> => {
  switch (cancellation.kind) {
    case 'acknowledged':
      await context.runtime.journal.emit({
        type: 'run.cancellation_acknowledged',
        operationId: context.operation,
      });
      await context.runtime.journal.publishDetails();
      await reconcileScriptCancellation(context);
      return;
    case 'alreadyTerminal':
      await sendScriptTerminalObservation(context, cancellation.result);
      return;
    case 'uncertain':
      await reconcileScriptCancellation(context);
      return;
    case 'notFound':
    case 'unknown':
      // dispatch_won excludes a false pre-dispatch cancellation. notFound is
      // not proof of no physical dispatch, so retain the same identity.
      await recordScriptCancellationRecovery(context);
      return;
    default:
      cancellation satisfies never;
      throw new Error('Script cancellation has an unsupported result.');
  }
};

const cancelScriptOperation = async (context: ScriptCancellationContext): Promise<void> => {
  let arbitration;
  try {
    arbitration = await arbitrateAttemptDispatch(
      attemptDispatchArbitrationCandidate(
        context.input.executionId,
        context.input.attemptId,
        'cancel_won',
      ),
    );
  } catch {
    await recordScriptCancellationRecovery(context);
    return;
  }
  if (arbitration.winner === 'cancel_won') {
    await sendScriptPreDispatchCancellation(context);
    return;
  }
  await applyScriptCancellationResult(context, await scriptCancellationResult(context));
};

const requestOperationCancellation = async (
  runtime: KernelWorkflowContext,
  command: HostedCommand,
  operation: string,
): Promise<void> => {
  if (command.kind !== 'dispatchActivity') {
    await sendGenericOperationCancellation(operation);
    return;
  }
  const requirement = runtime.snapshot.compilation.requirements.entries.find(
    (candidate) => candidate.key === command.requirementKey,
  );
  if (requirement?.kind !== 'script') {
    await sendGenericOperationCancellation(operation);
    return;
  }
  await cancelScriptOperation({
    runtime,
    command,
    operation,
    input: scriptAttemptInput(
      runtime.snapshot,
      command,
      operation,
      runtime.journal.activeAttemptOrdinal(operation),
    ),
  });
};

const cancelTargetOperations = async (
  runtime: KernelWorkflowContext,
  targets: readonly string[],
): Promise<void> => {
  for (const [operation, command] of runtime.active) {
    if (targets.includes(command.key)) {
      await requestOperationCancellation(runtime, command, operation);
    }
  }
};

const requestRunCancellation = async (
  runtime: KernelWorkflowContext,
  actorId: string,
): Promise<void> => {
  if (runtime.journal.result().snapshot.status === 'cancelling') {
    return;
  }
  const requested = await requestCancellationTransition(
    runtime.snapshot,
    runtime.state,
    runtime.journal,
    actorId,
  );
  runtime.state = requested.state;
  runtime.commands.unshift(...withoutHandledCancellation(requested.commands));
  const targets = requested.commands.filter(
    (command): command is Extract<PipelineCommand, { readonly kind: 'cancelPending' }> =>
      command.kind === 'cancelPending',
  );
  for (const target of targets) {
    await cancelTargetOperations(runtime, target.targets);
  }
};

const drainCommands = async (runtime: KernelWorkflowContext): Promise<KernelRunResult | null> => {
  while (runtime.commands.length > 0) {
    const command = runtime.commands.shift();
    if (command === undefined) {
      return null;
    }
    if (runtime.recoveryPending) {
      throw new Error('Recovery-required run attempted to dispatch a new kernel command.');
    }
    const terminal = terminalFor(command);
    if (terminal !== undefined) {
      if (runtime.active.size > 0) {
        throw new Error('Pipeline emitted a terminal command while operations remain active.');
      }
      await runtime.journal.finish(terminal);
      await runtime.journal.publishDetails();
      await DBOS.closeStream(eventStream);
      return runtime.journal.result();
    }
    if (command.kind === 'cancelPending') {
      await cancelTargetOperations(runtime, command.targets);
      continue;
    }
    if (!isHostedCommand(command)) {
      throw new Error(`Pipeline command ${command.kind} cannot be hosted as an operation.`);
    }
    await dispatchOperation(runtime, command);
  }
  return null;
};

const handleLiveRelay = async (
  runtime: KernelWorkflowContext,
  message: ScriptEventRelayV1,
): Promise<void> => {
  if (runtime.receipts.has(message.eventReceiptId)) {
    return;
  }
  if (runtime.recoveryOperations.has(message.operationId)) {
    runtime.receipts.add(message.eventReceiptId);
    return;
  }
  await drainLiveRelay(runtime.journal, runtime.snapshot.runId, runtime.active, message);
  runtime.receipts.add(message.eventReceiptId);
  await runtime.journal.publishDetails();
};

const handleRetryStartRelay = async (
  runtime: KernelWorkflowContext,
  message: OperationRetryStartRelayV1,
): Promise<void> => {
  if (runtime.receipts.has(message.retryReceiptId)) {
    return;
  }
  await applyRetryStartRelay(runtime.journal, runtime.snapshot.runId, runtime.active, message);
  runtime.receipts.add(message.retryReceiptId);
};

const handleRecoveryRelay = async (
  runtime: KernelWorkflowContext,
  message: OperationRecoveryRelayV1,
): Promise<KernelRunResult | null> => {
  if (runtime.receipts.has(message.observationReceiptId)) {
    return null;
  }
  await applyRecoveryRelay(runtime.journal, runtime.snapshot.runId, runtime.active, message);
  runtime.receipts.add(message.observationReceiptId);
  runtime.active.delete(message.operationId);
  runtime.recoveryPending = true;
  if (runtime.active.size > 0) {
    return null;
  }
  await DBOS.closeStream(eventStream);
  return runtime.journal.result();
};

const validateObservationRelay = (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
): HostedCommand | null => {
  if (
    message.runId !== runtime.snapshot.runId ||
    message.observationReceiptId !==
      operationReceiptId(runtime.snapshot.runId, message.operationId, message.attemptOrdinal ?? 1)
  ) {
    throw new Error('Operation observation relay has an invalid durable receipt.');
  }
  if (runtime.receipts.has(message.observationReceiptId)) {
    return null;
  }
  const command = runtime.active.get(message.operationId);
  if (command?.key !== message.commandKey) {
    throw new Error('Operation observation relay has no matching active command.');
  }
  return command;
};

const requireActivityAttemptOrdinal = (message: ObservationRelay): number => {
  if (
    message.attemptOrdinal === null ||
    !Number.isSafeInteger(message.attemptOrdinal) ||
    message.attemptOrdinal < 1
  ) {
    throw new Error('Activity observation did not include its attempt ordinal.');
  }
  return message.attemptOrdinal;
};

const applyPreDispatchObservation = async (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
  command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>,
  ordinal: number,
): Promise<ObservationDisposition> => {
  if (
    message.scriptResult !== null ||
    message.agentResult !== null ||
    message.retrying ||
    message.event.kind !== 'activityCancelled'
  ) {
    throw new Error('Pre-dispatch script cancellation has an invalid executor result.');
  }
  requireExactPipelineEvent(message.event, {
    kind: 'activityCancelled',
    commandKey: command.key,
    ref: command.ref,
  });
  await applyScriptPreDispatchCancellation(runtime.journal, message.operationId, ordinal);
  return 'settled';
};

const applyScriptRelayObservation = async (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
  command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>,
  ordinal: number,
): Promise<ObservationDisposition> => {
  if (message.preDispatchCancelled) {
    return await applyPreDispatchObservation(runtime, message, command, ordinal);
  }
  if (message.scriptResult === null || message.agentResult !== null) {
    throw new Error('Script observation did not include only its script result.');
  }
  const validation = await ScriptAttemptResultSchema.validate(message.scriptResult);
  if (!validation.ok || message.scriptResult.kind === 'uncertain') {
    throw new Error('Script observation does not contain a valid terminal result.');
  }
  await requireMatchingTerminalEvent(message.scriptResult, ordinal);
  requireExactPipelineEvent(
    message.event,
    deriveScriptTerminalPipelineEvent(command, message.scriptResult),
  );
  if (message.retrying) {
    if (message.scriptResult.kind !== 'failed' && message.scriptResult.kind !== 'timedOut') {
      throw new Error('Only a terminal script failure may request a retry.');
    }
    await applyScriptObservation(
      runtime.journal,
      message.operationId,
      ordinal,
      message.scriptResult,
      true,
    );
    return 'retrying';
  }
  const disposition = await applyScriptObservation(
    runtime.journal,
    message.operationId,
    ordinal,
    message.scriptResult,
  );
  if (disposition === 'uncertain') {
    return 'recovery';
  }
  runtime.recoveryOperations.delete(message.operationId);
  if (runtime.recoveryOperations.size === 0) {
    runtime.recoveryPending = false;
  }
  return 'settled';
};

const applyAgentRelayObservation = async (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
  command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>,
  ordinal: number,
  bindingKey: string,
): Promise<ObservationDisposition> => {
  if (
    message.scriptResult !== null ||
    message.agentResult === null ||
    message.retrying ||
    message.preDispatchCancelled
  ) {
    throw new Error('Agent observation has an invalid executor result.');
  }
  const binding = runtime.snapshot.bindings.agents?.[bindingKey];
  if (
    !isAgentInvocationResult(message.agentResult) ||
    binding === undefined ||
    message.agentResult.invocationId !== attemptId(message.operationId, ordinal) ||
    message.agentResult.pin.agentId !== binding.pin.agentId ||
    message.agentResult.pin.agentVersion !== binding.pin.agentVersion ||
    message.agentResult.pin.definitionDigest !== binding.pin.definitionDigest
  ) {
    throw new Error('Agent observation does not contain its admitted terminal result.');
  }
  requireExactPipelineEvent(
    message.event,
    deriveAgentTerminalPipelineEvent(command, message.agentResult),
  );
  await applyAgentObservation(
    runtime.journal,
    message.operationId,
    attemptId(message.operationId, ordinal),
    message.agentResult,
  );
  return 'settled';
};

const applyActivityRelayObservation = async (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
  command: Extract<HostedCommand, { readonly kind: 'dispatchActivity' }>,
): Promise<ObservationDisposition> => {
  const ordinal = requireActivityAttemptOrdinal(message);
  const requirement = runtime.snapshot.compilation.requirements.entries.find(
    (candidate) => candidate.key === command.requirementKey,
  );
  if (requirement?.kind === 'script') {
    return await applyScriptRelayObservation(runtime, message, command, ordinal);
  }
  if (requirement?.kind === 'agent') {
    return await applyAgentRelayObservation(
      runtime,
      message,
      command,
      ordinal,
      requirement.bindingKey,
    );
  }
  throw new Error('Activity observation has no admitted requirement.');
};

const applyNonActivityRelayObservation = async (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
  command: Exclude<HostedCommand, { readonly kind: 'dispatchActivity' }>,
): Promise<ObservationDisposition> => {
  if (
    message.scriptResult !== null ||
    message.agentResult !== null ||
    message.preDispatchCancelled
  ) {
    throw new Error('Non-activity operation included an executor result.');
  }
  if (message.attemptOrdinal !== null) {
    throw new Error('Non-script operation included a script attempt ordinal.');
  }
  if (message.retrying) {
    throw new Error('Non-script operation requested a script retry.');
  }
  await applyInteractionObservation(
    runtime.journal,
    runtime.snapshot.runId,
    command,
    message.event,
  );
  return 'settled';
};

const advanceSettledObservation = async (
  runtime: KernelWorkflowContext,
  event: PipelineEvent,
): Promise<KernelRunResult | null> => {
  if (runtime.recoveryPending) {
    // A sibling may seal while another external attempt is uncertain. Its
    // observation is durable, but advancing around the unknown result would
    // fabricate ordering. Preserve inbox order until recovery resolves.
    runtime.deferredKernelEvents.push(event);
    if (runtime.active.size > 0) {
      return null;
    }
    await DBOS.closeStream(eventStream);
    return runtime.journal.result();
  }
  const events = [...runtime.deferredKernelEvents, event];
  runtime.deferredKernelEvents.length = 0;
  for (const pending of events) {
    const transition = await advance(runtime.snapshot, runtime.state, pending);
    runtime.state = transition.state;
    runtime.commands.push(...transition.commands);
  }
  return null;
};

const finalizeObservation = async (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
  disposition: ObservationDisposition,
): Promise<KernelRunResult | null> => {
  runtime.receipts.add(message.observationReceiptId);
  if (disposition === 'retrying') {
    await runtime.journal.publishDetails();
    return null;
  }
  runtime.active.delete(message.operationId);
  if (disposition === 'recovery') {
    runtime.recoveryPending = true;
    if (runtime.active.size > 0) {
      return null;
    }
    await DBOS.closeStream(eventStream);
    return runtime.journal.result();
  }
  return await advanceSettledObservation(runtime, message.event);
};

const handleObservationRelay = async (
  runtime: KernelWorkflowContext,
  message: ObservationRelay,
): Promise<KernelRunResult | null> => {
  const command = validateObservationRelay(runtime, message);
  if (command === null) {
    return null;
  }
  const disposition =
    command.kind === 'dispatchActivity'
      ? await applyActivityRelayObservation(runtime, message, command)
      : await applyNonActivityRelayObservation(runtime, message, command);
  return await finalizeObservation(runtime, message, disposition);
};

const handleCoordinatorMessage = async (
  runtime: KernelWorkflowContext,
  message: RunCoordinatorMessage,
): Promise<KernelRunResult | null> => {
  if (message.schemaVersion === 'run-cancellation-request/v1') {
    if (typeof message.actorId !== 'string' || message.actorId.length === 0) {
      throw new Error('Run cancellation request has an invalid durable shape.');
    }
    await requestRunCancellation(runtime, message.actorId);
    return null;
  }
  if (message.schemaVersion === 'script-event-relay/v1') {
    await handleLiveRelay(runtime, message);
    return null;
  }
  if (message.schemaVersion === 'operation-retry-start-relay/v1') {
    await handleRetryStartRelay(runtime, message);
    return null;
  }
  if (message.schemaVersion === 'operation-recovery-relay/v1') {
    return await handleRecoveryRelay(runtime, message);
  }
  if (message.schemaVersion === 'operation-observation-relay/v1') {
    return await handleObservationRelay(runtime, message);
  }
  throw new Error('Coordinator inbox received an unrecognized message.');
};

const runCoordinator = async (runtime: KernelWorkflowContext): Promise<KernelRunResult> => {
  while (true) {
    const terminal = await drainCommands(runtime);
    if (terminal !== null) {
      return terminal;
    }
    const message = await DBOS.recv<RunCoordinatorMessage>(coordinatorTopic);
    if (message === null) {
      throw new Error('Coordinator inbox unexpectedly returned no message.');
    }
    const result = await handleCoordinatorMessage(runtime, message);
    if (result !== null) {
      return result;
    }
  }
};

export const runKernelWorkflow = async (
  snapshot: AdmittedRunSnapshotV1,
): Promise<KernelRunResult> => {
  requireCompatibleSnapshot(snapshot);
  const runtime = await initializeKernelContext(snapshot);
  return (await recoverUnavailableAgent(runtime)) ?? (await runCoordinator(runtime));
};

export const kernelRunWorkflow = DBOS.registerWorkflow(runKernelWorkflow, {
  name: kernelRunWorkflowName,
});
