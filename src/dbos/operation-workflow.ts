import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AgentProgramRequirement, ScriptProgramRequirement } from '@revisium/revo-pipeline';
import type { PipelineCommand, PipelineEvent } from '@revisium/revo-pipeline/kernel';
import {
  ScriptAttemptResultSchema,
  ScriptEventSchema,
  ScriptReconciliationResultSchema,
} from '@revisium/revo-scripts';
import type {
  ScriptAttemptInput,
  ScriptAttemptResult,
  ScriptEvent,
  ScriptIdentityPin,
  ScriptLiveEventEmission,
  ScriptTerminalAttemptResult,
} from '@revisium/revo-scripts';

import type {
  AgentResultLookup,
  AgentTerminalResult,
  PreparedAgentBinding,
} from '../composition/agent-port.js';
import { isAgentTerminalResult } from '../composition/agent-terminal-result.js';
import { requireRunComposition } from '../composition/run-composition.js';
import type { AdmittedRunSnapshotV1 } from '../contracts/admitted-run.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../contracts/json.js';
import {
  attemptId,
  eventReceiptId,
  operationReceiptId,
  recoveryReceiptId,
  retryStartReceiptId,
} from '../operations/identities.js';
import {
  arbitrateAttemptDispatch,
  attemptDispatchArbitrationCandidate,
} from './attempt-dispatch-arbitration.js';
import { operationWorkflowId } from './workflow-id.js';

export const runOperationWorkflowName = 'revo-run.operation-host/v1';
export const coordinatorTopic = 'revo-run.coordinator';
export const operationInteractionTopic = 'revo-run.operation';

const deepFreeze = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
};

const cloneFrozen = <Value>(value: Value): Value => {
  const cloned = structuredClone(value);
  deepFreeze(cloned);
  return cloned;
};

export interface ScriptEventRelayV1 {
  readonly schemaVersion: 'script-event-relay/v1';
  readonly eventReceiptId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly emissionOrdinal: number;
  readonly event: ScriptEvent;
}

export interface OperationObservationRelayV1 {
  readonly schemaVersion: 'operation-observation-relay/v1';
  readonly observationReceiptId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly commandKey: string;
  readonly attemptOrdinal: number | null;
  readonly retrying: boolean;
  readonly event: PipelineEvent;
  readonly scriptResult: ScriptAttemptResult | null;
  readonly agentResult: AgentTerminalResult | null;
  readonly preDispatchCancelled: boolean;
}

export interface ScriptDispatchIntentV1 {
  readonly schemaVersion: 'script-dispatch-intent/v1';
  readonly executionId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly recoveryAttemptBaseline: number;
}

export type OperationRecoveryReasonCode = 'outcome_unknown' | 'reconciliation_failed';

export interface OperationRecoveryRelayV1 {
  readonly schemaVersion: 'operation-recovery-relay/v1';
  readonly observationReceiptId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly commandKey: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly reasonCode: OperationRecoveryReasonCode;
}

/** Records the next durable script attempt before its backoff or dispatch. */
export interface OperationRetryStartRelayV1 {
  readonly schemaVersion: 'operation-retry-start-relay/v1';
  readonly retryReceiptId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly commandKey: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
}

export interface RunCancellationRequestV1 {
  readonly schemaVersion: 'run-cancellation-request/v1';
  readonly actorId: string;
}

export type RunCoordinatorMessage =
  | ScriptEventRelayV1
  | OperationObservationRelayV1
  | OperationRecoveryRelayV1
  | OperationRetryStartRelayV1
  | RunCancellationRequestV1;

export interface OperationInteractionMessage {
  readonly schemaVersion: 'operation-interaction/v1';
  readonly kind: 'cancel' | 'signal' | 'gate';
  readonly actorId: string;
  readonly signal?: string;
  readonly answer?: string;
  readonly actorGroups?: readonly string[];
  readonly payload?: JsonValue | null;
}

export interface OperationOutboxRecordV1 {
  readonly schemaVersion: 'run-operation-outbox/v1';
  readonly runId: string;
  readonly operationId: string;
  readonly command: Extract<
    PipelineCommand,
    { readonly kind: 'dispatchActivity' | 'scheduleWait' | 'openHumanGate' }
  >;
}

export interface RunOperationWorkflowInput {
  readonly schemaVersion: 'run-operation-workflow-input/v1';
  readonly runId: string;
  readonly operationId: string;
  readonly rootWorkflowId: string;
}

export const operationOutboxKey = (operationId: string): string =>
  `revo-run.operation-outbox:${operationId}`;

const admittedSnapshot = async (rootWorkflowId: string): Promise<AdmittedRunSnapshotV1> => {
  const [snapshot] =
    await DBOS.retrieveWorkflow(rootWorkflowId).getWorkflowInputs<[AdmittedRunSnapshotV1]>();
  if (snapshot?.persistenceVersion !== 1) {
    throw new Error('Operation workflow cannot load its admitted run snapshot.');
  }
  return snapshot;
};

const outboxRecord = async (
  rootWorkflowId: string,
  operationId: string,
): Promise<OperationOutboxRecordV1> => {
  const record = await DBOS.getEvent<OperationOutboxRecordV1>(
    rootWorkflowId,
    operationOutboxKey(operationId),
    { timeoutSeconds: 0 },
  );
  if (record?.schemaVersion !== 'run-operation-outbox/v1' || record.operationId !== operationId) {
    throw new Error('Operation workflow cannot load its durable outbox record.');
  }
  return record;
};

const scriptRequirement = (
  snapshot: AdmittedRunSnapshotV1,
  requirementKey: string,
): ScriptProgramRequirement => {
  const requirement = snapshot.compilation.requirements.entries.find(
    (candidate) => candidate.key === requirementKey,
  );
  if (requirement?.kind !== 'script') {
    throw new Error(`Admitted script requirement ${requirementKey} is unavailable.`);
  }
  return requirement;
};

const scriptRequirementOrNull = (
  snapshot: AdmittedRunSnapshotV1,
  requirementKey: string,
): ScriptProgramRequirement | null => {
  const requirement = snapshot.compilation.requirements.entries.find(
    (candidate) => candidate.key === requirementKey,
  );
  return requirement?.kind === 'script' ? requirement : null;
};

const agentRequirement = (
  snapshot: AdmittedRunSnapshotV1,
  requirementKey: string,
): AgentProgramRequirement => {
  const requirement = snapshot.compilation.requirements.entries.find(
    (candidate) => candidate.key === requirementKey,
  );
  if (requirement?.kind !== 'agent') {
    throw new Error(`Admitted agent requirement ${requirementKey} is unavailable.`);
  }
  return requirement;
};

const scriptPin = (value: { readonly id: string; readonly version: number }): ScriptIdentityPin => {
  const id = value.id;
  if (!isScriptIdentity(id)) {
    throw new Error('Admitted script requirement has an invalid script pin.');
  }
  return { id, version: value.version };
};

const isScriptIdentity = (value: string): value is `script:${string}` =>
  value.startsWith('script:');

const attemptInput = (
  snapshot: AdmittedRunSnapshotV1,
  command: Extract<PipelineCommand, { readonly kind: 'dispatchActivity' }>,
  operationId: string,
  ordinal: number,
): ScriptAttemptInput => {
  const requirement = scriptRequirement(snapshot, command.requirementKey);
  const binding = snapshot.bindings.scripts[requirement.key];
  if (binding === undefined) {
    throw new Error('Admitted script binding is unavailable.');
  }
  return {
    executionId: operationId,
    attemptId: attemptId(operationId, ordinal),
    attemptOrdinal: ordinal,
    script: scriptPin(requirement.script),
    binding,
    input: command.input,
  };
};

const agentBinding = (
  snapshot: AdmittedRunSnapshotV1,
  requirement: AgentProgramRequirement,
): PreparedAgentBinding => {
  const binding = snapshot.bindings.agents?.[requirement.bindingKey];
  if (binding === undefined) {
    throw new Error('Admitted agent binding is unavailable.');
  }
  return binding;
};

const agentActivityInput = (
  value: JsonValue,
): Readonly<{ readonly prompt: string; readonly metadata?: JsonObject }> => {
  if (!isJsonObject(value) || typeof value.prompt !== 'string') {
    throw new Error('Admitted agent command has an invalid activity input.');
  }
  if (value.metadata !== undefined && !isJsonObject(value.metadata)) {
    throw new Error('Admitted agent command has invalid metadata.');
  }
  return value.metadata === undefined
    ? { prompt: value.prompt }
    : { prompt: value.prompt, metadata: value.metadata };
};

interface OperationObservation {
  readonly event: PipelineEvent;
  readonly scriptResult: ScriptAttemptResult | null;
  readonly attemptOrdinal: number | null;
  readonly retrying: boolean;
  readonly agentResult?: AgentTerminalResult | null;
  readonly preDispatchCancelled?: boolean;
}

const sendObservation = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
  observation: OperationObservation,
): Promise<void> => {
  const {
    event,
    scriptResult,
    attemptOrdinal,
    retrying,
    agentResult = null,
    preDispatchCancelled = false,
  } = observation;
  const observationReceiptId = operationReceiptId(
    input.runId,
    input.operationId,
    attemptOrdinal ?? 1,
  );
  const relay: OperationObservationRelayV1 = {
    schemaVersion: 'operation-observation-relay/v1',
    observationReceiptId,
    runId: input.runId,
    operationId: input.operationId,
    commandKey: record.command.key,
    attemptOrdinal,
    retrying,
    event,
    scriptResult,
    agentResult,
    preDispatchCancelled,
  };
  await DBOS.send(input.rootWorkflowId, relay, coordinatorTopic, observationReceiptId);
};

const sendRecovery = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
  attempt: Readonly<{ readonly attemptId: string; readonly attemptOrdinal: number }>,
  reasonCode: OperationRecoveryReasonCode,
): Promise<void> => {
  const observationReceiptId = recoveryReceiptId(
    input.runId,
    input.operationId,
    attempt.attemptOrdinal,
  );
  const relay: OperationRecoveryRelayV1 = {
    schemaVersion: 'operation-recovery-relay/v1',
    observationReceiptId,
    runId: input.runId,
    operationId: input.operationId,
    commandKey: record.command.key,
    attemptId: attempt.attemptId,
    attemptOrdinal: attempt.attemptOrdinal,
    reasonCode,
  };
  await DBOS.send(input.rootWorkflowId, relay, coordinatorTopic, observationReceiptId);
};

const sendPreDispatchCancellation = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
  attempt: Readonly<{ readonly attemptOrdinal: number }>,
): Promise<void> => {
  await sendObservation(input, record, {
    event: {
      kind: 'activityCancelled',
      commandKey: record.command.key,
      ref: record.command.ref,
    },
    scriptResult: null,
    attemptOrdinal: attempt.attemptOrdinal,
    retrying: false,
    agentResult: null,
    preDispatchCancelled: true,
  });
};

const sendRetryStart = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
  attempt: ScriptAttemptInput,
): Promise<void> => {
  const receipt = retryStartReceiptId(input.runId, input.operationId, attempt.attemptOrdinal);
  const relay: OperationRetryStartRelayV1 = {
    schemaVersion: 'operation-retry-start-relay/v1',
    retryReceiptId: receipt,
    runId: input.runId,
    operationId: input.operationId,
    commandKey: record.command.key,
    attemptId: attempt.attemptId,
    attemptOrdinal: attempt.attemptOrdinal,
  };
  await DBOS.send(input.rootWorkflowId, relay, coordinatorTopic, receipt);
};

export const requireScriptDispatchRecoveryAttempt = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Script operation cannot read its durable recovery attempt.');
  }
  return value;
};

export const scriptDispatchAction = (
  recoveryAttemptBaseline: number,
  currentRecoveryAttempt: number,
): 'execute' | 'reconcile' => {
  if (currentRecoveryAttempt === recoveryAttemptBaseline) {
    return 'execute';
  }
  if (currentRecoveryAttempt > recoveryAttemptBaseline) {
    return 'reconcile';
  }
  throw new Error('Script operation recovery attempt decreased after dispatch intent.');
};

const recoveryAttempt = async (workflowId: string): Promise<number> => {
  const status = await DBOS.getWorkflowStatus(workflowId);
  return requireScriptDispatchRecoveryAttempt(status?.recoveryAttempts);
};

type ScriptDecisionPhase = 'initial' | 'reconcile' | 'reexecute';

const dispatchIntentStepName = (phase: ScriptDecisionPhase, currentAttemptId: string): string => {
  if (phase === 'initial') {
    return `script-dispatch-intent:${currentAttemptId}`;
  }
  if (phase === 'reconcile') {
    return `script-reconcile-dispatch-intent:${currentAttemptId}`;
  }
  return `script-reexecute-dispatch-intent:${currentAttemptId}`;
};

const dispatchIntent = async (
  workflowId: string,
  attempt: ScriptAttemptInput,
  phase: ScriptDecisionPhase = 'initial',
) =>
  await DBOS.runStep(
    async (): Promise<ScriptDispatchIntentV1> => {
      const recoveryAttemptBaseline = await recoveryAttempt(workflowId);
      return {
        schemaVersion: 'script-dispatch-intent/v1',
        executionId: attempt.executionId,
        attemptId: attempt.attemptId,
        attemptOrdinal: attempt.attemptOrdinal,
        recoveryAttemptBaseline,
      };
    },
    {
      name: dispatchIntentStepName(phase, attempt.attemptId),
      retriesAllowed: false,
    },
  );

const executeAttempt = async (
  composition: ReturnType<typeof requireRunComposition>,
  rootWorkflowId: string,
  runId: string,
  attempt: ScriptAttemptInput,
): Promise<ScriptAttemptResult | null> => {
  const result = await composition.scripts.executeAttempt(attempt, {
    signal: new AbortController().signal,
    events: {
      emit: async (emission: ScriptLiveEventEmission): Promise<void> => {
        const validated = await ScriptEventSchema.validate(emission.event);
        if (!validated.ok) {
          throw new Error('Script live event does not satisfy the owning event schema.');
        }
        const relay: ScriptEventRelayV1 = {
          schemaVersion: 'script-event-relay/v1',
          eventReceiptId: eventReceiptId(
            runId,
            attempt.executionId,
            attempt.attemptId,
            emission.emissionOrdinal,
          ),
          runId,
          operationId: attempt.executionId,
          attemptId: attempt.attemptId,
          attemptOrdinal: attempt.attemptOrdinal,
          emissionOrdinal: emission.emissionOrdinal,
          event: cloneFrozen(emission.event),
        };
        await DBOS.send(rootWorkflowId, relay, coordinatorTopic, relay.eventReceiptId);
      },
    },
  });
  const validated = await ScriptAttemptResultSchema.validate(result);
  return validated.ok ? cloneFrozen(result) : null;
};

const providerDecisionStepName = (phase: ScriptDecisionPhase, currentAttemptId: string): string => {
  if (phase === 'initial') {
    return `script-provider-dispatch:${currentAttemptId}`;
  }
  if (phase === 'reconcile') {
    return `script-reconcile-provider:${currentAttemptId}`;
  }
  return `script-reexecute-provider:${currentAttemptId}`;
};

interface ScriptResolution {
  readonly result: ScriptAttemptResult | null;
  readonly recoveryReason: OperationRecoveryReasonCode | null;
  readonly requiresFreshDispatch: boolean;
  readonly cancelledBeforeDispatch: boolean;
}

const unknownOutcome = (): Extract<ScriptAttemptResult, { readonly kind: 'uncertain' }> => ({
  kind: 'uncertain',
  trigger: 'cancellation',
  stage: 'handler',
  evidence: [],
});

const reconcileWithinProvider = async (
  composition: ReturnType<typeof requireRunComposition>,
  attempt: ScriptAttemptInput,
): Promise<ScriptResolution> => {
  try {
    const rawReconciliation = await composition.scripts.reconcileAttempt(attempt, {
      signal: new AbortController().signal,
    });
    const validated = await ScriptReconciliationResultSchema.validate(rawReconciliation);
    if (!validated.ok) {
      return {
        result: unknownOutcome(),
        recoveryReason: 'outcome_unknown',
        requiresFreshDispatch: false,
        cancelledBeforeDispatch: false,
      };
    }
    const reconciliation = cloneFrozen(rawReconciliation);
    if (reconciliation.kind === 'terminal') {
      return {
        result: reconciliation.result,
        recoveryReason: null,
        requiresFreshDispatch: false,
        cancelledBeforeDispatch: false,
      };
    }
    if (reconciliation.kind === 'uncertain') {
      return {
        result: reconciliation.result,
        recoveryReason: 'outcome_unknown',
        requiresFreshDispatch: false,
        cancelledBeforeDispatch: false,
      };
    }
    if (reconciliation.kind === 'unknown') {
      return {
        result: unknownOutcome(),
        recoveryReason: 'outcome_unknown',
        requiresFreshDispatch: false,
        cancelledBeforeDispatch: false,
      };
    }
    return {
      result: null,
      recoveryReason: null,
      requiresFreshDispatch: true,
      cancelledBeforeDispatch: false,
    };
  } catch {
    return {
      result: unknownOutcome(),
      recoveryReason: 'reconciliation_failed',
      requiresFreshDispatch: false,
      cancelledBeforeDispatch: false,
    };
  }
};

const providerDecision = async (
  composition: ReturnType<typeof requireRunComposition>,
  rootWorkflowId: string,
  runId: string,
  workflowId: string,
  attempt: ScriptAttemptInput,
  intent: ScriptDispatchIntentV1,
  phase: ScriptDecisionPhase,
): Promise<ScriptResolution> => {
  // The child does not write an arbitration record until the host is ready.
  // Every durable provider-decision generation reads or claims the winner
  // before it calls executeAttempt or reconcileAttempt.
  await composition.fence.awaitOpen();
  let arbitration;
  try {
    arbitration = await arbitrateAttemptDispatch(
      attemptDispatchArbitrationCandidate(attempt.executionId, attempt.attemptId, 'dispatch_won'),
    );
  } catch {
    return {
      result: unknownOutcome(),
      recoveryReason: 'outcome_unknown',
      requiresFreshDispatch: false,
      cancelledBeforeDispatch: false,
    };
  }
  if (arbitration.winner === 'cancel_won') {
    return {
      result: null,
      recoveryReason: null,
      requiresFreshDispatch: false,
      cancelledBeforeDispatch: true,
    };
  }
  return await DBOS.runStep(
    async (): Promise<ScriptResolution> => {
      await composition.fence.awaitOpen();
      const current = await recoveryAttempt(workflowId);
      const action = scriptDispatchAction(intent.recoveryAttemptBaseline, current);
      if ((phase === 'initial' || phase === 'reexecute') && action === 'execute') {
        const result = await executeAttempt(composition, rootWorkflowId, runId, attempt);
        if (result === null) {
          return {
            result: unknownOutcome(),
            recoveryReason: 'outcome_unknown',
            requiresFreshDispatch: false,
            cancelledBeforeDispatch: false,
          };
        }
        return {
          result,
          recoveryReason: null,
          requiresFreshDispatch: false,
          cancelledBeforeDispatch: false,
        };
      }
      const reconciliation = await reconcileWithinProvider(composition, attempt);
      // Re-execution receives one fresh durable intent.  A crash after it has
      // started may only reconcile; it cannot authorize another physical call.
      if (phase === 'reexecute' && reconciliation.requiresFreshDispatch) {
        return {
          result: unknownOutcome(),
          recoveryReason: 'outcome_unknown',
          requiresFreshDispatch: false,
          cancelledBeforeDispatch: false,
        };
      }
      return reconciliation;
    },
    {
      name: providerDecisionStepName(phase, attempt.attemptId),
      retriesAllowed: false,
    },
  );
};

const reconcileScript = async (
  rootWorkflowId: string,
  runId: string,
  attempt: ScriptAttemptInput,
): Promise<ScriptResolution> => {
  const composition = requireRunComposition();
  const workflowId = DBOS.workflowID;
  if (workflowId === undefined || workflowId !== operationWorkflowId(attempt.executionId)) {
    throw new Error('Script operation has no stable child workflow identity.');
  }
  const intent = await dispatchIntent(workflowId, attempt);
  let resolution = await providerDecision(
    composition,
    rootWorkflowId,
    runId,
    workflowId,
    attempt,
    intent,
    'initial',
  );
  if (resolution.result !== null && resolution.result.kind !== 'uncertain') {
    return resolution;
  }
  if (!resolution.requiresFreshDispatch) {
    const reconciliationIntent = await dispatchIntent(workflowId, attempt, 'reconcile');
    resolution = await providerDecision(
      composition,
      rootWorkflowId,
      runId,
      workflowId,
      attempt,
      reconciliationIntent,
      'reconcile',
    );
  }
  if (!resolution.requiresFreshDispatch) {
    return resolution;
  }
  const reexecuteIntent = await dispatchIntent(workflowId, attempt, 'reexecute');
  resolution = await providerDecision(
    composition,
    rootWorkflowId,
    runId,
    workflowId,
    attempt,
    reexecuteIntent,
    'reexecute',
  );
  return resolution;
};

const shouldRetry = (attempt: ScriptAttemptInput, result: ScriptTerminalAttemptResult): boolean =>
  (result.kind === 'failed' || result.kind === 'timedOut') &&
  result.error.retryable &&
  attempt.binding.attemptPolicy.retry.mode === 'transient' &&
  attempt.attemptOrdinal < attempt.binding.attemptPolicy.retry.maxAttempts &&
  attempt.binding.attemptPolicy.idempotency !== 'not-retryable';

const retryDelay = (attempt: ScriptAttemptInput): number =>
  attempt.binding.attemptPolicy.retry.backoffMs[attempt.attemptOrdinal - 1] ?? 0;

const scriptOperation = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
  snapshot: AdmittedRunSnapshotV1,
): Promise<void> => {
  if (record.command.kind !== 'dispatchActivity') {
    throw new Error('Script operation received a non-activity command.');
  }
  let ordinal = 1;
  while (true) {
    const attempt = attemptInput(snapshot, record.command, input.operationId, ordinal);
    // oxlint-disable-next-line no-await-in-loop -- each retry must await the prior durable outcome.
    const resolution = await reconcileScript(input.rootWorkflowId, input.runId, attempt);
    if (resolution.cancelledBeforeDispatch) {
      // The root may have crashed after winning cancellation but before its
      // relay committed. The receipt key is shared with that relay, so this
      // child repairs exactly the same terminal observation.
      // oxlint-disable-next-line no-await-in-loop -- this attempt lane must relay before it stops.
      await sendPreDispatchCancellation(input, record, attempt);
      return;
    }
    if (resolution.result === null || resolution.result.kind === 'uncertain') {
      // oxlint-disable-next-line no-await-in-loop -- recovery relay terminates this serial attempt lane.
      await sendRecovery(input, record, attempt, resolution.recoveryReason ?? 'outcome_unknown');
      return;
    }
    const result = resolution.result;
    if (shouldRetry(attempt, result)) {
      // oxlint-disable-next-line no-await-in-loop -- the prior terminal result is durable before retry.
      await sendObservation(input, record, {
        event: scriptPipelineEvent(record.command, result),
        scriptResult: result,
        attemptOrdinal: attempt.attemptOrdinal,
        retrying: true,
      });
      const nextAttempt = attemptInput(
        snapshot,
        record.command,
        input.operationId,
        attempt.attemptOrdinal + 1,
      );
      // The root records the next attempt as running before this operation can
      // sleep or issue a second physical dispatch.  Replays use the same
      // durable receipt and therefore cannot create a duplicate ordinal.
      // oxlint-disable-next-line no-await-in-loop -- retry-start must commit before backoff.
      await sendRetryStart(input, record, nextAttempt);
      const delay = retryDelay(attempt);
      if (delay > 0) {
        // oxlint-disable-next-line no-await-in-loop -- backoff is a durable sequence boundary.
        await DBOS.sleep(delay);
      }
      ordinal += 1;
      continue;
    }
    const event = scriptPipelineEvent(record.command, result);
    // oxlint-disable-next-line no-await-in-loop -- final observation completes this serial attempt lane.
    await sendObservation(input, record, {
      event,
      scriptResult: result,
      attemptOrdinal: attempt.attemptOrdinal,
      retrying: false,
    });
    return;
  }
};

const scriptPipelineEvent = (
  command: Extract<PipelineCommand, { readonly kind: 'dispatchActivity' }>,
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
  if (result.kind === 'timedOut' || result.kind === 'failed') {
    return {
      kind: 'activityFailed',
      commandKey: command.key,
      ref: command.ref,
      errorCode: result.error.code,
    };
  }
  result satisfies never;
  throw new Error('Script operation received a non-terminal result.');
};

interface AgentDispatchIntentV1 {
  readonly schemaVersion: 'agent-dispatch-intent/v1';
  readonly invocationId: string;
  readonly recoveryAttemptBaseline: number;
}

interface AgentOperationAttempt {
  readonly attemptId: string;
  readonly attemptOrdinal: 1;
  readonly binding: PreparedAgentBinding;
  readonly requirement: AgentProgramRequirement;
  readonly command: Extract<PipelineCommand, { readonly kind: 'dispatchActivity' }>;
}

const samePin = (
  left: Readonly<{
    readonly agentId: string;
    readonly agentVersion: string;
    readonly definitionDigest: string;
  }>,
  right: Readonly<{
    readonly agentId: string;
    readonly agentVersion: string;
    readonly definitionDigest: string;
  }>,
): boolean =>
  left.agentId === right.agentId &&
  left.agentVersion === right.agentVersion &&
  left.definitionDigest === right.definitionDigest;

const agentAttempt = (
  snapshot: AdmittedRunSnapshotV1,
  command: Extract<PipelineCommand, { readonly kind: 'dispatchActivity' }>,
  operationId: string,
): AgentOperationAttempt => {
  const requirement = agentRequirement(snapshot, command.requirementKey);
  return {
    attemptId: attemptId(operationId, 1),
    attemptOrdinal: 1,
    binding: agentBinding(snapshot, requirement),
    requirement,
    command,
  };
};

const agentDispatchIntent = async (
  workflowId: string,
  attempt: AgentOperationAttempt,
): Promise<AgentDispatchIntentV1> =>
  await DBOS.runStep(
    async () => ({
      schemaVersion: 'agent-dispatch-intent/v1',
      invocationId: attempt.attemptId,
      recoveryAttemptBaseline: await recoveryAttempt(workflowId),
    }),
    { name: `agent-dispatch-intent:${attempt.attemptId}`, retriesAllowed: false },
  );

const agentPipelineEvent = (
  command: Extract<PipelineCommand, { readonly kind: 'dispatchActivity' }>,
  result: AgentTerminalResult,
): PipelineEvent => {
  if (result.status === 'succeeded') {
    if (result.value === undefined) {
      throw new Error('Agent success result is missing its value.');
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

const validAgentResult = (
  result: unknown,
  attempt: AgentOperationAttempt,
): result is AgentTerminalResult =>
  isAgentTerminalResult(result) &&
  result.invocationId === attempt.attemptId &&
  samePin(result.pin, attempt.binding.pin);

type AgentResolution =
  | Readonly<{ readonly kind: 'terminal'; readonly result: AgentTerminalResult }>
  | Readonly<{ readonly kind: 'running' }>
  | Readonly<{ readonly kind: 'recovery' }>;

const resolveAgentLookup = (
  lookup: AgentResultLookup,
  attempt: AgentOperationAttempt,
): AgentResolution => {
  if (lookup.state === 'completed') {
    return validAgentResult(lookup.result, attempt)
      ? { kind: 'terminal', result: lookup.result }
      : { kind: 'recovery' };
  }
  if (
    lookup.state === 'running' &&
    lookup.invocation.invocationId === attempt.attemptId &&
    samePin(lookup.invocation.pin, attempt.binding.pin)
  ) {
    return { kind: 'running' };
  }
  return { kind: 'recovery' };
};

const lookupAgentResult = (
  composition: ReturnType<typeof requireRunComposition>,
  attempt: AgentOperationAttempt,
): AgentResolution => {
  try {
    return resolveAgentLookup(composition.agents.getResult(attempt.attemptId), attempt);
  } catch {
    return { kind: 'recovery' };
  }
};

const agentCancellation = async (
  composition: ReturnType<typeof requireRunComposition>,
  attempt: AgentOperationAttempt,
): Promise<AgentResolution> => {
  try {
    const result = await composition.agents.cancel(attempt.attemptId, 'run.cancel_requested');
    if (result.state === 'already_completed') {
      return validAgentResult(result.result, attempt)
        ? { kind: 'terminal', result: result.result }
        : { kind: 'recovery' };
    }
    if (result.state === 'unknown') {
      return { kind: 'recovery' };
    }
    return lookupAgentResult(composition, attempt);
  } catch {
    return { kind: 'recovery' };
  }
};

const sendAgentResolution = async (
  resolution: AgentResolution,
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
  attempt: AgentOperationAttempt,
): Promise<boolean> => {
  if (record.command.kind !== 'dispatchActivity') {
    throw new Error('Agent resolution has a non-activity command.');
  }
  if (resolution.kind === 'running') {
    return false;
  }
  if (resolution.kind === 'recovery') {
    await sendRecovery(input, record, attempt, 'outcome_unknown');
    return true;
  }
  await sendObservation(input, record, {
    event: agentPipelineEvent(record.command, resolution.result),
    scriptResult: null,
    attemptOrdinal: 1,
    retrying: false,
    agentResult: resolution.result,
  });
  return true;
};

const agentOperation = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
  snapshot: AdmittedRunSnapshotV1,
): Promise<void> => {
  if (record.command.kind !== 'dispatchActivity') {
    throw new Error('Agent operation received a non-activity command.');
  }
  const attempt = agentAttempt(snapshot, record.command, input.operationId);
  const composition = requireRunComposition();
  const workflowId = DBOS.workflowID;
  if (workflowId === undefined || workflowId !== operationWorkflowId(input.operationId)) {
    throw new Error('Agent operation has no stable child workflow identity.');
  }
  const intent = await agentDispatchIntent(workflowId, attempt);
  let resolution = await DBOS.runStep(
    async (): Promise<AgentResolution> => {
      await composition.fence.awaitOpen();
      const action = scriptDispatchAction(
        intent.recoveryAttemptBaseline,
        await recoveryAttempt(workflowId),
      );
      if (action === 'reconcile') {
        return lookupAgentResult(composition, attempt);
      }
      try {
        const activity = agentActivityInput(attempt.command.input);
        const outcome = await composition.agents.start({
          invocationId: attempt.attemptId,
          binding: attempt.binding,
          prompt: activity.prompt,
          ...(activity.metadata === undefined ? {} : { metadata: activity.metadata }),
          result: { schema: attempt.requirement.outputSchema },
        });
        if (outcome.status === 'unknown') {
          return { kind: 'recovery' };
        }
        if (outcome.status === 'rejected') {
          return validAgentResult(outcome.result, attempt)
            ? { kind: 'terminal', result: outcome.result }
            : { kind: 'recovery' };
        }
        if (
          outcome.handle.invocationId !== attempt.attemptId ||
          !samePin(outcome.handle.pin, attempt.binding.pin)
        ) {
          return { kind: 'recovery' };
        }
        return lookupAgentResult(composition, attempt);
      } catch {
        return { kind: 'recovery' };
      }
    },
    { name: `agent-provider-dispatch:${attempt.attemptId}`, retriesAllowed: false },
  );
  if (await sendAgentResolution(resolution, input, record, attempt)) {
    return;
  }
  let pollOrdinal = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- this one operation must receive cancellation and lookup observations in durable order.
    const interaction = await DBOS.recv<OperationInteractionMessage>(operationInteractionTopic, {
      timeoutSeconds: 1,
    });
    if (interaction !== null) {
      if (
        interaction.schemaVersion !== 'operation-interaction/v1' ||
        interaction.kind !== 'cancel'
      ) {
        throw new Error('Agent operation received an invalid interaction.');
      }
      // oxlint-disable-next-line no-await-in-loop -- cancellation reconciliation is the next durable operation observation.
      resolution = await DBOS.runStep(async () => await agentCancellation(composition, attempt), {
        name: `agent-cancel-reconcile:${attempt.attemptId}`,
        retriesAllowed: false,
      });
    } else {
      pollOrdinal += 1;
      // oxlint-disable-next-line no-await-in-loop -- each bounded poll must be recorded as its own DBOS step.
      resolution = await DBOS.runStep(async () => lookupAgentResult(composition, attempt), {
        name: `agent-result-lookup:${attempt.attemptId}:${pollOrdinal}`,
        retriesAllowed: false,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- the terminal/recovery relay ends this serial operation lane.
    if (await sendAgentResolution(resolution, input, record, attempt)) {
      return;
    }
  }
};

const receiveInteraction = async (): Promise<OperationInteractionMessage> => {
  const message = await DBOS.recv<OperationInteractionMessage>(operationInteractionTopic);
  if (message?.schemaVersion !== 'operation-interaction/v1') {
    throw new Error('Operation interaction has an invalid durable shape.');
  }
  return message;
};

const waitInteractionEvent = (
  command: Extract<PipelineCommand, { readonly kind: 'scheduleWait' }>,
  message: OperationInteractionMessage,
  signal: string,
): PipelineEvent => {
  if (message.kind === 'cancel') {
    return { kind: 'waitCancelled', commandKey: command.key, ref: command.ref };
  }
  if (message.kind === 'signal' && message.signal === signal) {
    return {
      kind: 'signalReceived',
      commandKey: command.key,
      ref: command.ref,
      signal: message.signal,
      payload: message.payload ?? null,
    };
  }
  return failInteraction('wait');
};

const waitOperation = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
): Promise<void> => {
  await requireRunComposition().fence.awaitOpen();
  if (record.command.kind !== 'scheduleWait') {
    throw new Error('Wait operation received a non-wait command.');
  }
  if (record.command.wait.kind === 'duration') {
    const message = await durationInteraction(record.command.wait.durationMs);
    const event: PipelineEvent =
      message.kind === 'cancel'
        ? { kind: 'waitCancelled', commandKey: record.command.key, ref: record.command.ref }
        : { kind: 'waitCompleted', commandKey: record.command.key, ref: record.command.ref };
    await sendObservation(input, record, {
      event,
      scriptResult: null,
      attemptOrdinal: null,
      retrying: false,
    });
    return;
  }
  const message = await receiveInteraction();
  await sendObservation(input, record, {
    event: waitInteractionEvent(record.command, message, record.command.wait.signal),
    scriptResult: null,
    attemptOrdinal: null,
    retrying: false,
  });
};

const durationInteraction = async (durationMs: number): Promise<OperationInteractionMessage> => {
  const message = await DBOS.recv<OperationInteractionMessage>(operationInteractionTopic, {
    timeoutSeconds: durationMs / 1_000,
  });
  if (message === null) {
    return { schemaVersion: 'operation-interaction/v1', kind: 'signal', actorId: 'timer' };
  }
  if (message.schemaVersion !== 'operation-interaction/v1') {
    throw new Error('Operation interaction has an invalid durable shape.');
  }
  return message;
};

const gateInteractionEvent = (
  command: Extract<PipelineCommand, { readonly kind: 'openHumanGate' }>,
  message: OperationInteractionMessage,
): PipelineEvent => {
  if (message.kind === 'cancel') {
    return { kind: 'gateCancelled', commandKey: command.key, ref: command.ref };
  }
  if (message.kind === 'signal' && message.actorId === 'timer') {
    return {
      kind: 'gateResolved',
      commandKey: command.key,
      ref: command.ref,
      resolution: { kind: 'deadline' },
    };
  }
  if (
    message.kind === 'gate' &&
    message.answer !== undefined &&
    command.answers.includes(message.answer) &&
    command.authorizationRequirements.every((group) => message.actorGroups?.includes(group))
  ) {
    return {
      kind: 'gateResolved',
      commandKey: command.key,
      ref: command.ref,
      resolution: {
        kind: 'answer',
        answer: message.answer,
        actorRef: message.actorId,
        payload: message.payload ?? null,
      },
    };
  }
  return failInteraction('gate');
};

const gateOperation = async (
  input: RunOperationWorkflowInput,
  record: OperationOutboxRecordV1,
): Promise<void> => {
  await requireRunComposition().fence.awaitOpen();
  if (record.command.kind !== 'openHumanGate') {
    throw new Error('Gate operation received a non-gate command.');
  }
  const message =
    record.command.deadline === null
      ? await receiveInteraction()
      : await durationInteraction(record.command.deadline.afterMs);
  await sendObservation(input, record, {
    event: gateInteractionEvent(record.command, message),
    scriptResult: null,
    attemptOrdinal: null,
    retrying: false,
  });
};

const failInteraction = (kind: string): never => {
  throw new Error(`Operation received an invalid ${kind} interaction.`);
};

export const runOperationWorkflow = async (input: RunOperationWorkflowInput): Promise<void> => {
  const [snapshot, record] = await Promise.all([
    admittedSnapshot(input.rootWorkflowId),
    outboxRecord(input.rootWorkflowId, input.operationId),
  ]);
  if (record.runId !== input.runId) {
    throw new Error('Operation outbox record belongs to a different run.');
  }
  switch (record.command.kind) {
    case 'dispatchActivity':
      if (scriptRequirementOrNull(snapshot, record.command.requirementKey) !== null) {
        await scriptOperation(input, record, snapshot);
      } else {
        await agentOperation(input, record, snapshot);
      }
      return;
    case 'scheduleWait':
      await waitOperation(input, record);
      return;
    case 'openHumanGate':
      await gateOperation(input, record);
      return;
    default:
      record.command satisfies never;
      throw new Error('Operation outbox contains an unsupported command.');
  }
};

export const operationWorkflowID = (operationId: string): string =>
  operationWorkflowId(operationId);

export const registeredRunOperationWorkflow = DBOS.registerWorkflow(runOperationWorkflow, {
  name: runOperationWorkflowName,
});
