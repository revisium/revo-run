import { AsyncLocalStorage } from 'node:async_hooks';

import { DBOS, DBOSClient, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import {
  PipelineProgramSchema,
  PipelineSourcePackageSchema,
  ProgramProvenanceSchema,
  ProgramRequirementsSchema,
  ValueSchemaSchema,
} from '@revisium/revo-pipeline';
import { PipelineCommandSchema, PipelineStateSchema } from '@revisium/revo-pipeline/kernel';
import { Check } from 'typebox/value';

import { admitRun } from '../admission/admit-run.js';
import {
  clearRunComposition,
  createRunComposition,
  installRunComposition,
  type RunComposition,
} from '../composition/run-composition.js';
import type { AdmittedRunSnapshotV1 } from '../contracts/admitted-run.js';
import { isJsonValue } from '../contracts/json.js';
import type {
  AnswerGateInput,
  CancelRunInput,
  CreateRunInput,
  CreateRunManagerOptions,
  CreateRunResult,
  ListRunsFilter,
  RunEventPageInput,
  RunEventSubscriptionInput,
  RunManager,
  SendSignalInput,
  WaitForTerminalInput,
} from '../contracts/manager.js';
import { unknownRunFailure } from '../contracts/normalize-run-public-failure.js';
import type {
  RunDetails,
  RunEvent,
  RunEventPage,
  RunPage,
  RunSnapshot,
} from '../contracts/observation.js';
import {
  AnswerGateInputSchema,
  CancelRunInputSchema,
  RunDetailsSchema,
  RunEventSchema,
  RunIdSchema,
  RunSnapshotSchema,
  SendSignalInputSchema,
  WaitForTerminalInputSchema,
  isUtcTimestamp,
} from '../contracts/public-schemas.js';
import { RunManagerError } from '../contracts/run-manager-error.js';
import { RunProfileSchema } from '../contracts/run-profile.js';
import { loadAgentActiveInvocationSnapshots } from '../dbos/agent-active-invocation-registry.js';
import {
  gateConfigurationKey,
  runEventHighWaterKey,
  signalWaitConfigurationKey,
  type GateConfigurationV1,
  type SignalWaitConfigurationV1,
} from '../dbos/interaction-records.js';
import {
  kernelRunWorkflow,
  kernelRunWorkflowName,
  type KernelRunResult,
} from '../dbos/kernel-run-workflow.js';
import {
  coordinatorTopic,
  operationInteractionTopic,
  type OperationInteractionMessage,
} from '../dbos/operation-workflow.js';
import { operationWorkflowId, runWorkflowId } from '../dbos/workflow-id.js';

const applicationName = 'revo-run';
const interactionDeliveryAttempts = 300;
const interactionDeliveryDelayMs = 50;

export const runManagerStopOrder = Object.freeze(['agents.shutdown', 'dbos.shutdown'] as const);

const timestamp = (value: number | undefined): string =>
  new Date(value ?? Date.now()).toISOString();

const activeSnapshot = (runId: string, createdAt: number, updatedAt?: number): RunSnapshot =>
  Object.freeze({
    schemaVersion: 'run-snapshot/v1',
    runId,
    status: 'running',
    createdAt: timestamp(createdAt),
    updatedAt: timestamp(updatedAt ?? createdAt),
    terminal: null,
  });

const failedSnapshot = (runId: string, createdAt: number, updatedAt?: number): RunSnapshot =>
  Object.freeze({
    schemaVersion: 'run-snapshot/v1',
    runId,
    status: 'failed',
    createdAt: timestamp(createdAt),
    updatedAt: timestamp(updatedAt ?? createdAt),
    terminal: Object.freeze({ kind: 'failed', error: unknownRunFailure() }),
  });

const isKernelRunResult = (value: unknown, runId: string): value is KernelRunResult =>
  isRecord(value) &&
  Check(RunSnapshotSchema, value.snapshot) &&
  Check(RunDetailsSchema, value.details) &&
  value.snapshot.runId === runId &&
  value.details.runId === runId &&
  value.snapshot.status === value.details.status &&
  JSON.stringify(value.snapshot.terminal) === JSON.stringify(value.details.terminal);

const isConsistentRunEvent = (
  value: unknown,
  runId: string,
  previousSequence: number,
  highWater: number,
): value is RunEvent =>
  Check(RunEventSchema, value) &&
  value.runId === runId &&
  value.sequence === previousSequence + 1 &&
  value.sequence <= highWater &&
  value.cursor === `${runId}:${value.sequence}`;

const isTerminalStatus = (status: RunSnapshot['status']): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';

const isActiveDbosStatus = (status: string): boolean =>
  status === 'PENDING' || status === 'ENQUEUED' || status === 'DELAYED';

const failedDetails = (snapshot: RunSnapshot): RunDetails =>
  Object.freeze({
    ...snapshot,
    schemaVersion: 'run-details/v1',
    activities: [],
    operations: [],
    attempts: [],
    waits: [],
    gates: [],
    recovery: [],
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// DBOS creates its system tables during launch. Before the first launch, the
// compatibility scan has no persisted roots to inspect; only this exact
// PostgreSQL missing-table response represents that empty initial state.
const isFreshDbosSystemDatabase = (error: unknown): boolean =>
  isRecord(error) &&
  error.code === '42P01' &&
  error.message === 'relation "dbos.workflow_status" does not exist';

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isSafePositiveInteger = (value: unknown): value is number =>
  isSafeNonNegativeInteger(value) && value > 0;

const isIdentifierList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 256);

const parseFilterTime = (value: string | undefined, path: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new RunManagerError('invalid_list_runs_filter', { path, reason: 'timestamp' });
  }
  if (!isUtcTimestamp(value)) {
    throw new RunManagerError('invalid_list_runs_filter', { path, reason: 'timestamp' });
  }
  return Date.parse(value);
};

type CursorParseResult =
  | Readonly<{ readonly ok: true; readonly sequence: number }>
  | Readonly<{ readonly ok: false; readonly reason: 'malformed' | 'foreign' }>;

const parseCursor = (runId: string, cursor: unknown): CursorParseResult => {
  if (typeof cursor !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const separator = cursor.lastIndexOf(':');
  if (separator <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (cursor.slice(0, separator) !== runId) {
    return { ok: false, reason: 'foreign' };
  }
  const sequence = cursor.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(sequence)) {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = Number(sequence);
  return Number.isSafeInteger(parsed)
    ? { ok: true, sequence: parsed }
    : { ok: false, reason: 'malformed' };
};

const hasOnlyKeys = (
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));

const isPageInput = (value: unknown): value is RunEventPageInput =>
  hasOnlyKeys(value, ['after', 'limit']) &&
  (value.after === undefined || typeof value.after === 'string') &&
  (value.limit === undefined || (isSafePositiveInteger(value.limit) && value.limit <= 100));

const isSubscriptionInput = (value: unknown): value is RunEventSubscriptionInput =>
  hasOnlyKeys(value, ['after']) && (value.after === undefined || typeof value.after === 'string');

const isWaitInput = (value: unknown): value is WaitForTerminalInput =>
  Check(WaitForTerminalInputSchema, value);

const isTerminalDbosStatus = (status: string): boolean =>
  status === 'SUCCESS' ||
  status === 'ERROR' ||
  status === 'CANCELLED' ||
  status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' ||
  status === 'RETRIES_EXCEEDED';

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const hasAllowedKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isPreparedScriptBinding = (value: unknown): boolean => {
  if (!isRecord(value) || !isJsonValue(value)) {
    return false;
  }
  return (
    hasExactKeys(value, [
      'schemaVersion',
      'script',
      'definitionDigest',
      'implementation',
      'providers',
      'resources',
      'credentials',
      'attemptPolicy',
    ]) &&
    value.schemaVersion === 'prepared-script-binding/v1' &&
    isRecord(value.script) &&
    hasExactKeys(value.script, ['id', 'version']) &&
    isNonEmptyString(value.script.id) &&
    Number.isSafeInteger(value.script.version) &&
    typeof value.definitionDigest === 'string' &&
    isRecord(value.implementation) &&
    hasExactKeys(value.implementation, ['id', 'version', 'buildDigest']) &&
    isNonEmptyString(value.implementation.id) &&
    isNonEmptyString(value.implementation.version) &&
    typeof value.implementation.buildDigest === 'string' &&
    Array.isArray(value.providers) &&
    isRecord(value.resources) &&
    isRecord(value.credentials) &&
    isRecord(value.attemptPolicy) &&
    hasExactKeys(value.attemptPolicy, ['timeoutMs', 'terminationGraceMs', 'retry', 'idempotency'])
  );
};

const isPreparedAgentBinding = (value: unknown): boolean =>
  isRecord(value) &&
  isJsonValue(value) &&
  hasExactKeys(value, ['schemaVersion', 'pin', 'parameters', 'permissions', 'workspaceRef']) &&
  value.schemaVersion === 'prepared-agent-binding/v1' &&
  isRecord(value.pin) &&
  hasExactKeys(value.pin, ['agentId', 'agentVersion', 'definitionDigest']) &&
  isNonEmptyString(value.pin.agentId) &&
  isNonEmptyString(value.pin.agentVersion) &&
  isNonEmptyString(value.pin.definitionDigest) &&
  isRecord(value.parameters) &&
  isRecord(value.permissions) &&
  isNonEmptyString(value.workspaceRef);

const isCompatiblePersistedRun = (value: unknown): value is AdmittedRunSnapshotV1 => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'persistenceVersion',
      'runId',
      'raw',
      'compilation',
      'bindings',
      'initial',
      'admission',
    ]) ||
    value.persistenceVersion !== 1 ||
    !Check(RunIdSchema, value.runId) ||
    !isRecord(value.raw) ||
    !hasExactKeys(value.raw, ['pipeline', 'profile', 'input']) ||
    !Check(PipelineSourcePackageSchema, value.raw.pipeline) ||
    !Check(RunProfileSchema, value.raw.profile) ||
    !isJsonValue(value.raw.input) ||
    !isRecord(value.compilation) ||
    !hasExactKeys(value.compilation, [
      'program',
      'requirements',
      'provenance',
      'sourceDigest',
      'materializationDigest',
      'programDigest',
    ]) ||
    !Check(PipelineProgramSchema, value.compilation.program) ||
    !Check(ProgramRequirementsSchema, value.compilation.requirements) ||
    !Check(ProgramProvenanceSchema, value.compilation.provenance) ||
    !isNonEmptyString(value.compilation.sourceDigest) ||
    !isNonEmptyString(value.compilation.materializationDigest) ||
    !isNonEmptyString(value.compilation.programDigest) ||
    !isRecord(value.bindings) ||
    !hasAllowedKeys(value.bindings, ['scripts', 'agents']) ||
    !isRecord(value.bindings.scripts) ||
    !Object.values(value.bindings.scripts).every(isPreparedScriptBinding) ||
    !isRecord(value.initial) ||
    !hasExactKeys(value.initial, ['state', 'commands']) ||
    !Check(PipelineStateSchema, value.initial.state) ||
    !Array.isArray(value.initial.commands) ||
    !value.initial.commands.every((command) => Check(PipelineCommandSchema, command)) ||
    !isRecord(value.admission) ||
    !hasExactKeys(value.admission, ['createdAt', 'token']) ||
    !isNonEmptyString(value.admission.token) ||
    typeof value.admission.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.admission.createdAt))
  ) {
    return false;
  }
  return (
    value.bindings.agents === undefined ||
    (isRecord(value.bindings.agents) &&
      Object.values(value.bindings.agents).every(isPreparedAgentBinding))
  );
};

const hasAdmissionToken = (value: unknown, token: string): value is AdmittedRunSnapshotV1 =>
  typeof value === 'object' &&
  value !== null &&
  'persistenceVersion' in value &&
  value.persistenceVersion === 1 &&
  'admission' in value &&
  typeof value.admission === 'object' &&
  value.admission !== null &&
  'token' in value.admission &&
  value.admission.token === token;

const sendOperationInteraction = async (
  workflowId: string,
  message: OperationInteractionMessage,
  deduplicationId: string,
): Promise<void> => {
  // A recovered child may still be transitioning from DBOS recovery into its
  // receive loop after its durable wait/gate publication is visible. Reusing
  // the exact transport key makes this bounded retry one logical interaction.
  for (let retry = 0; retry < interactionDeliveryAttempts; retry += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one durable message is retried with its fixed key.
      await DBOS.send(workflowId, message, operationInteractionTopic, deduplicationId);
      return;
    } catch (error) {
      if (retry === interactionDeliveryAttempts - 1) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- bounded recovery handoff retry uses one durable key.
      await new Promise<void>((resolve) => setTimeout(resolve, interactionDeliveryDelayMs));
    }
  }
};

const readRunEventsThroughHighWater = async (
  runId: string,
  after: number,
  highWater: number,
): Promise<RunEvent[]> => {
  const events: RunEvent[] = [];
  let observedSequence = 0;
  try {
    for await (const event of DBOS.readStream<RunEvent>(runWorkflowId(runId), 'revo-run.events')) {
      if (!isConsistentRunEvent(event, runId, observedSequence, highWater)) {
        throw new Error('Persisted run event violates the public contract.');
      }
      observedSequence = event.sequence;
      if (event.sequence > after) {
        events.push(event);
      }
      if (event.sequence >= highWater) {
        break;
      }
    }
    if (highWater > 0 && observedSequence !== highWater) {
      throw new Error('Persisted run-event stream ended before its high-water mark.');
    }
  } catch {
    throw new RunManagerError('run_read_failed', { runId, operation: 'get_events' });
  }
  return events;
};

type CompatibilityClient = Awaited<ReturnType<typeof DBOSClient.create>>;

const listCompatibilityPage = async (
  client: CompatibilityClient,
  offset: number,
): Promise<readonly WorkflowStatus[] | null> => {
  try {
    return await client.listWorkflows({ offset, limit: 100, loadInput: true });
  } catch (error) {
    if (isFreshDbosSystemDatabase(error)) {
      return null;
    }
    throw error;
  }
};

const persistedRootRunId = (workflowId: string): string | null =>
  workflowId.startsWith('revo-run:') ? workflowId.slice('revo-run:'.length) : null;

const assertCompatiblePersistedWorkflow = (workflow: WorkflowStatus): void => {
  if (isTerminalDbosStatus(workflow.status)) {
    return;
  }
  const persistedRunId = persistedRootRunId(workflow.workflowID);
  const isCurrentRoot = workflow.workflowName === kernelRunWorkflowName;
  if (persistedRunId === null && !isCurrentRoot) {
    return;
  }
  const persistedInput = workflow.input?.[0];
  if (
    persistedRunId === null ||
    !Check(RunIdSchema, persistedRunId) ||
    !isCurrentRoot ||
    !isCompatiblePersistedRun(persistedInput) ||
    persistedInput.runId !== persistedRunId
  ) {
    throw new Error('A nonterminal revo-run workflow has an incompatible persisted input.');
  }
};

export class DefaultRunManager implements RunManager {
  private composition: RunComposition | undefined;
  private lifecycle: 'created' | 'running' | 'stopping' | 'stopped' = 'created';
  private readonly publicCallScope = new AsyncLocalStorage<symbol>();
  private activePublicCalls = 0;
  private readonly drainedCallWaiters: (() => void)[] = [];
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: CreateRunManagerOptions) {}

  async start(): Promise<void> {
    if (this.lifecycle === 'running') {
      return;
    }
    if (this.lifecycle === 'stopping') {
      throw new RunManagerError('manager_not_started', { lifecycle: 'stopping' });
    }
    const composition = createRunComposition(this.options);
    let launchStarted = false;
    try {
      DBOS.setConfig({ name: applicationName, systemDatabaseUrl: this.options.database.url });
      await this.assertPersistedRunsCompatible();
      installRunComposition(composition);
      launchStarted = true;
      await DBOS.launch();
      const activeInvocations = await loadAgentActiveInvocationSnapshots();
      await composition.agents.initialize(activeInvocations);
      composition.fence.open();
      this.composition = composition;
      this.lifecycle = 'running';
    } catch {
      clearRunComposition(composition);
      await composition.agents.shutdown('run_manager_start_failed').catch(() => undefined);
      if (launchStarted) {
        await DBOS.shutdown().catch(() => undefined);
      }
      throw new RunManagerError('manager_start_failed', {
        operation: launchStarted ? 'dbos_launch' : 'host_initialization',
      });
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'stopping') {
      await this.stopPromise;
      return;
    }
    if (this.lifecycle !== 'running') {
      this.lifecycle = 'stopped';
      return;
    }
    this.lifecycle = 'stopping';
    const stopping = this.stopAfterPublicCallsDrain();
    this.stopPromise = stopping;
    await stopping;
  }

  private async stopAfterPublicCallsDrain(): Promise<void> {
    await this.waitForPublicCallsToDrain();
    let failure: 'dbos_shutdown' | 'agent_shutdown' | undefined;
    if (this.composition !== undefined) {
      try {
        await this.composition.agents.shutdown('run_manager_stop');
      } catch {
        failure = 'agent_shutdown';
      }
    }
    try {
      await DBOS.shutdown();
    } catch {
      failure ??= 'dbos_shutdown';
    }
    if (this.composition !== undefined) {
      clearRunComposition(this.composition);
    }
    this.composition = undefined;
    this.lifecycle = 'stopped';
    if (failure !== undefined) {
      throw new RunManagerError('manager_stop_failed', { operation: failure });
    }
  }

  private async withPublicCall<T>(action: () => Promise<T>): Promise<T> {
    if (this.publicCallScope.getStore() !== undefined) {
      return await action();
    }
    const release = this.enterPublicCall();
    try {
      return await this.publicCallScope.run(Symbol('revo-run-public-call'), action);
    } finally {
      release();
    }
  }

  private enterPublicCall(): () => void {
    this.assertStarted();
    this.activePublicCalls += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activePublicCalls -= 1;
      if (this.activePublicCalls === 0) {
        for (const resolve of this.drainedCallWaiters.splice(0)) {
          resolve();
        }
      }
    };
  }

  private async waitForPublicCallsToDrain(): Promise<void> {
    if (this.activePublicCalls === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.drainedCallWaiters.push(resolve));
  }

  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    return await this.withPublicCall(async () => await this.createRunInScope(input));
  }

  private async createRunInScope(input: CreateRunInput): Promise<CreateRunResult> {
    const composition = this.composition;
    if (composition === undefined) {
      throw new RunManagerError('manager_not_started', { lifecycle: 'created' });
    }
    const admitted = await admitRun(input, composition);
    const workflowId = runWorkflowId(admitted.runId);
    try {
      await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: workflowId })(admitted);
    } catch {
      const status = await DBOS.getWorkflowStatus(workflowId).catch(() => null);
      const ownAdmission = await this.hasAdmissionToken(workflowId, admitted.admission.token);
      if (ownAdmission) {
        return { runId: admitted.runId };
      }
      if (status !== null) {
        throw new RunManagerError('run_id_conflict', { runId: admitted.runId });
      }
      throw new RunManagerError('run_admission_failed', { operation: 'workflow_start' });
    }
    if (!(await this.hasAdmissionToken(workflowId, admitted.admission.token))) {
      throw new RunManagerError('run_id_conflict', { runId: admitted.runId });
    }
    return { runId: admitted.runId };
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    return await this.withPublicCall(async () => await this.getRunInScope(runId));
  }

  private async getRunInScope(runId: string): Promise<RunSnapshot | undefined> {
    this.requireRunId(runId);
    const status = await this.workflowStatus(runId, 'get_run');
    if (status?.workflowName !== kernelRunWorkflowName) {
      return undefined;
    }
    if (status.status === 'SUCCESS') {
      return (await this.completedKernelResult(runId, 'get_run')).snapshot;
    }
    if (!isActiveDbosStatus(status.status)) {
      return failedSnapshot(runId, status.createdAt, status.updatedAt);
    }
    const published = await this.publishedDetails(runId, 'get_run');
    if (published !== null && Check(RunDetailsSchema, published)) {
      return Object.freeze({
        schemaVersion: 'run-snapshot/v1',
        runId: published.runId,
        status: published.status,
        createdAt: published.createdAt,
        updatedAt: published.updatedAt,
        terminal: published.terminal,
      });
    }
    return activeSnapshot(runId, status.createdAt, status.updatedAt);
  }

  async getRunDetails(runId: string): Promise<RunDetails | undefined> {
    return await this.withPublicCall(async () => await this.getRunDetailsInScope(runId));
  }

  private async getRunDetailsInScope(runId: string): Promise<RunDetails | undefined> {
    this.requireRunId(runId);
    const status = await this.workflowStatus(runId, 'get_details');
    if (status?.workflowName !== kernelRunWorkflowName) {
      return undefined;
    }
    if (status.status !== 'SUCCESS') {
      if (!isActiveDbosStatus(status.status)) {
        return failedDetails(failedSnapshot(runId, status.createdAt, status.updatedAt));
      }
      const published = await this.publishedDetails(runId, 'get_details');
      if (published !== null) {
        return published;
      }
      return failedDetails(activeSnapshot(runId, status.createdAt, status.updatedAt));
    }
    return (await this.completedKernelResult(runId, 'get_details')).details;
  }

  async listRuns(filter: ListRunsFilter = {}): Promise<RunPage> {
    return await this.withPublicCall(async () => await this.listRunsInScope(filter));
  }

  private async listRunsInScope(filter: ListRunsFilter = {}): Promise<RunPage> {
    const rawFilter: unknown = filter;
    if (!hasOnlyKeys(rawFilter, ['statuses', 'createdAtFrom', 'createdAtTo', 'offset', 'limit'])) {
      throw new RunManagerError('invalid_list_runs_filter', { path: '/filter', reason: 'page' });
    }
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    if (!isSafeNonNegativeInteger(offset) || !isSafePositiveInteger(limit) || limit > 100) {
      throw new RunManagerError('invalid_list_runs_filter', { path: '/filter', reason: 'page' });
    }
    if (
      filter.statuses !== undefined &&
      (!Array.isArray(filter.statuses) ||
        new Set(filter.statuses).size !== filter.statuses.length ||
        !filter.statuses.every(
          (status) =>
            status === 'pending' ||
            status === 'running' ||
            status === 'cancelling' ||
            status === 'recovery_required' ||
            status === 'succeeded' ||
            status === 'failed' ||
            status === 'cancelled',
        ))
    ) {
      throw new RunManagerError('invalid_list_runs_filter', {
        path: '/filter/statuses',
        reason: 'statuses',
      });
    }
    const createdAtFrom = parseFilterTime(filter.createdAtFrom, '/filter/createdAtFrom');
    const createdAtTo = parseFilterTime(filter.createdAtTo, '/filter/createdAtTo');
    if (createdAtFrom !== undefined && createdAtTo !== undefined && createdAtFrom > createdAtTo) {
      throw new RunManagerError('invalid_list_runs_filter', {
        path: '/filter',
        reason: 'inverted_time_range',
      });
    }
    const workflows = await this.listKernelWorkflows(filter);
    const snapshots: RunSnapshot[] = [];
    for (const workflow of workflows) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- DBOS status reads preserve the stable list order.
        const snapshot = await this.getRun(workflow.workflowID.slice('revo-run:'.length));
        if (snapshot !== undefined && (filter.statuses?.includes(snapshot.status) ?? true)) {
          snapshots.push(snapshot);
        }
      } catch {
        throw new RunManagerError('run_read_failed', { runId: null, operation: 'list_runs' });
      }
    }
    const ordered = snapshots.toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.runId.localeCompare(right.runId),
    );
    const selected = ordered.slice(offset, offset + limit);
    return Object.freeze({
      items: Object.freeze(selected),
      nextOffset: offset + selected.length < ordered.length ? offset + selected.length : null,
    });
  }

  async getRunEvents(runId: string, page: RunEventPageInput = {}): Promise<RunEventPage> {
    return await this.withPublicCall(async () => await this.getRunEventsInScope(runId, page));
  }

  private async getRunEventsInScope(
    runId: string,
    page: RunEventPageInput = {},
  ): Promise<RunEventPage> {
    this.requireRunId(runId);
    const snapshot = await this.getRun(runId);
    if (snapshot === undefined) {
      throw new RunManagerError('run_not_found', { runId });
    }
    if (!isPageInput(page)) {
      throw new RunManagerError('invalid_run_event_page_input', {
        path: '/page',
        reason: 'invalid_page',
      });
    }
    const limit = page.limit ?? 100;
    const cursor =
      page.after === undefined
        ? { ok: true as const, sequence: 0 }
        : parseCursor(runId, page.after);
    if (!cursor.ok) {
      throw new RunManagerError('run_event_cursor_invalid', { runId, reason: cursor.reason });
    }
    const after = cursor.sequence;
    const highWater = await this.eventHighWater(runId, 'get_events');
    if (highWater === null) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    if (!isSafeNonNegativeInteger(highWater)) {
      throw new RunManagerError('run_read_failed', { runId, operation: 'get_events' });
    }
    if (after > highWater) {
      throw new RunManagerError('run_event_cursor_invalid', { runId, reason: 'ahead' });
    }
    const events = await readRunEventsThroughHighWater(runId, after, highWater);
    const items = events.slice(0, limit);
    return {
      items,
      nextCursor: items.at(-1)?.cursor ?? null,
      hasMore: events.length > items.length,
    };
  }

  async *subscribeRunEvents(
    runId: string,
    input: RunEventSubscriptionInput = {},
  ): AsyncIterable<RunEvent> {
    const release = this.enterPublicCall();
    try {
      yield* this.subscribeRunEventsInScope(runId, input);
    } finally {
      release();
    }
  }

  private async *subscribeRunEventsInScope(
    runId: string,
    input: RunEventSubscriptionInput = {},
  ): AsyncIterable<RunEvent> {
    this.requireRunId(runId);
    const snapshot = await this.getRunInScope(runId);
    if (snapshot === undefined) {
      throw new RunManagerError('run_not_found', { runId });
    }
    if (!isSubscriptionInput(input)) {
      throw new RunManagerError('invalid_run_event_subscription_input', {
        path: '/subscription',
        reason: 'invalid_subscription',
      });
    }
    const cursor =
      input.after === undefined
        ? { ok: true as const, sequence: 0 }
        : parseCursor(runId, input.after);
    if (!cursor.ok) {
      throw new RunManagerError('run_event_cursor_invalid', { runId, reason: cursor.reason });
    }
    const highWater = await this.eventHighWater(runId, 'get_events');
    if (highWater !== null && cursor.sequence > highWater) {
      throw new RunManagerError('run_event_cursor_invalid', { runId, reason: 'ahead' });
    }
    if (highWater !== null && !isSafeNonNegativeInteger(highWater)) {
      throw new RunManagerError('run_event_subscription_failed', { runId });
    }
    let observedSequence = 0;
    let lastDeliveredSequence = cursor.sequence;
    try {
      for await (const event of DBOS.readStream<RunEvent>(
        runWorkflowId(runId),
        'revo-run.events',
      )) {
        if (
          !Check(RunEventSchema, event) ||
          event.runId !== runId ||
          event.cursor !== `${runId}:${event.sequence}` ||
          event.sequence !== observedSequence + 1
        ) {
          throw new Error('Persisted subscription event violates the public contract.');
        }
        observedSequence = event.sequence;
        if (event.sequence > lastDeliveredSequence) {
          yield event;
          lastDeliveredSequence = event.sequence;
        }
      }
    } catch {
      throw new RunManagerError('run_event_subscription_failed', { runId });
    }
  }

  async waitForTerminal(runId: string, input: WaitForTerminalInput = {}): Promise<RunSnapshot> {
    return await this.withPublicCall(async () => await this.waitForTerminalInScope(runId, input));
  }

  private async waitForTerminalInScope(
    runId: string,
    input: WaitForTerminalInput = {},
  ): Promise<RunSnapshot> {
    this.requireRunId(runId);
    if (!isWaitInput(input)) {
      throw new RunManagerError('invalid_wait_for_terminal_input', {
        path: '/input',
        reason: 'invalid_wait',
      });
    }
    const startedAt = Date.now();
    while (true) {
      if (input.signal?.aborted === true) {
        throw new RunManagerError('run_wait_aborted', { runId });
      }
      // oxlint-disable-next-line no-await-in-loop -- terminal observation is ordered polling, not concurrent work.
      const snapshot = await this.getRun(runId);
      if (snapshot === undefined) {
        throw new RunManagerError('run_not_found', { runId });
      }
      if (snapshot.status === 'recovery_required') {
        // oxlint-disable-next-line no-await-in-loop -- recovery entries belong to the same current observation.
        const details = await this.getRunDetails(runId);
        throw new RunManagerError('run_recovery_required', {
          runId,
          attempts:
            details?.recovery.map(({ operationId, attemptId }) => ({ operationId, attemptId })) ??
            [],
        });
      }
      if (isTerminalStatus(snapshot.status)) {
        return snapshot;
      }
      if (input.timeoutMs !== undefined && Date.now() - startedAt >= input.timeoutMs) {
        throw new RunManagerError('run_wait_timed_out', { runId, timeoutMs: input.timeoutMs });
      }
      // oxlint-disable-next-line no-await-in-loop -- this is the explicit poll interval.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async cancelRun(input: CancelRunInput): Promise<void> {
    await this.withPublicCall(async () => await this.cancelRunInScope(input));
  }

  private async cancelRunInScope(input: CancelRunInput): Promise<void> {
    const runId = this.requireRunId(isRecord(input) ? input.runId : undefined);
    if (!Check(CancelRunInputSchema, input)) {
      throw new RunManagerError('run_interaction_failed', {
        runId,
        operation: 'cancel',
      });
    }
    const snapshot = await this.getRun(runId);
    if (snapshot === undefined) {
      throw new RunManagerError('run_not_found', { runId });
    }
    if (isTerminalStatus(snapshot.status) || snapshot.status === 'cancelling') {
      return;
    }
    if (snapshot.status === 'recovery_required') {
      const details = await this.getRunDetails(runId);
      throw new RunManagerError('run_recovery_required', {
        runId,
        attempts:
          details?.recovery.map(({ operationId, attemptId }) => ({ operationId, attemptId })) ?? [],
      });
    }
    try {
      await DBOS.send(
        runWorkflowId(runId),
        { schemaVersion: 'run-cancellation-request/v1', actorId: input.actorId },
        coordinatorTopic,
        `cancel:${runId}`,
      );
    } catch {
      throw new RunManagerError('run_interaction_failed', {
        runId,
        operation: 'cancel',
      });
    }
  }

  async sendSignal(input: SendSignalInput): Promise<void> {
    await this.withPublicCall(async () => await this.sendSignalInScope(input));
  }

  private async sendSignalInScope(input: SendSignalInput): Promise<void> {
    const runId = this.requireRunId(isRecord(input) ? input.runId : undefined);
    if (!Check(SendSignalInputSchema, input)) {
      throw new RunManagerError('run_interaction_failed', { runId, operation: 'signal' });
    }
    const snapshot = await this.getRun(runId);
    if (snapshot === undefined) {
      throw new RunManagerError('run_not_found', { runId });
    }
    const details = await this.getRunDetails(runId);
    const wait = details?.waits.find((candidate) => candidate.waitId === input.waitId);
    if (wait?.kind !== 'signal') {
      throw new RunManagerError('run_wait_not_found', {
        runId,
        waitId: input.waitId,
        path: null,
      });
    }
    if (wait.status !== 'pending') {
      throw new RunManagerError('run_wait_already_resolved', {
        runId,
        waitId: input.waitId,
        path: null,
      });
    }
    if (wait.signal !== input.signal) {
      throw new RunManagerError('run_signal_invalid', {
        runId,
        waitId: input.waitId,
        path: '/signal',
      });
    }
    if (input.payload !== undefined && !isJsonValue(input.payload)) {
      throw new RunManagerError('run_signal_payload_invalid', {
        runId: input.runId,
        waitId: input.waitId,
        path: '/payload',
      });
    }
    const configuration = await DBOS.getEvent<SignalWaitConfigurationV1>(
      runWorkflowId(runId),
      signalWaitConfigurationKey(input.waitId),
      { timeoutSeconds: 0 },
    ).catch(() => null);
    if (
      configuration?.schemaVersion !== 'run-signal-wait-configuration/v1' ||
      typeof configuration.operationId !== 'string' ||
      configuration.operationId.length === 0 ||
      (configuration.payloadSchema !== null &&
        !Check(ValueSchemaSchema, configuration.payloadSchema))
    ) {
      throw new RunManagerError('run_interaction_failed', {
        runId,
        operation: 'signal',
      });
    }
    if (
      configuration.payloadSchema !== null &&
      !Check(configuration.payloadSchema, input.payload ?? null)
    ) {
      throw new RunManagerError('run_signal_payload_invalid', {
        runId,
        waitId: input.waitId,
        path: '/payload',
      });
    }
    try {
      await sendOperationInteraction(
        operationWorkflowId(configuration.operationId),
        {
          schemaVersion: 'operation-interaction/v1',
          kind: 'signal',
          signal: input.signal,
          payload: input.payload ?? null,
          actorId: input.actorId,
        },
        `signal:${input.waitId}`,
      );
    } catch {
      throw new RunManagerError('run_interaction_failed', {
        runId,
        operation: 'signal',
      });
    }
  }

  async answerGate(input: AnswerGateInput): Promise<void> {
    await this.withPublicCall(async () => await this.answerGateInScope(input));
  }

  private async answerGateInScope(input: AnswerGateInput): Promise<void> {
    const runId = this.requireRunId(isRecord(input) ? input.runId : undefined);
    if (!Check(AnswerGateInputSchema, input)) {
      throw new RunManagerError('run_interaction_failed', { runId, operation: 'gate' });
    }
    const snapshot = await this.getRun(runId);
    if (snapshot === undefined) {
      throw new RunManagerError('run_not_found', { runId });
    }
    const details = await this.getRunDetails(runId);
    const gate = details?.gates.find((candidate) => candidate.gateId === input.gateId);
    if (gate === undefined) {
      throw new RunManagerError('run_gate_not_found', {
        runId,
        gateId: input.gateId,
        path: null,
      });
    }
    if (gate.status !== 'pending') {
      throw new RunManagerError('run_gate_already_resolved', {
        runId,
        gateId: input.gateId,
        path: null,
      });
    }
    if (!gate.answers.includes(input.answer)) {
      throw new RunManagerError('run_gate_answer_invalid', {
        runId,
        gateId: input.gateId,
        path: '/answer',
      });
    }
    const configuration = await DBOS.getEvent<GateConfigurationV1>(
      runWorkflowId(runId),
      gateConfigurationKey(input.gateId),
      { timeoutSeconds: 0 },
    ).catch(() => null);
    if (
      configuration?.schemaVersion !== 'run-gate-configuration/v1' ||
      typeof configuration.operationId !== 'string' ||
      configuration.operationId.length === 0 ||
      !isIdentifierList(configuration.authorizationRequirements) ||
      (configuration.payloadSchema !== null &&
        !Check(ValueSchemaSchema, configuration.payloadSchema))
    ) {
      throw new RunManagerError('run_interaction_failed', {
        runId,
        operation: 'gate',
      });
    }
    const actorGroups = input.actorGroups ?? [];
    if (!configuration.authorizationRequirements.every((group) => actorGroups.includes(group))) {
      throw new RunManagerError('run_gate_unauthorized', {
        runId: input.runId,
        gateId: input.gateId,
        path: null,
      });
    }
    if (input.payload !== undefined && !isJsonValue(input.payload)) {
      throw new RunManagerError('run_gate_payload_invalid', {
        runId: input.runId,
        gateId: input.gateId,
        path: '/payload',
      });
    }
    if (
      configuration.payloadSchema !== null &&
      !Check(configuration.payloadSchema, input.payload ?? null)
    ) {
      throw new RunManagerError('run_gate_payload_invalid', {
        runId: input.runId,
        gateId: input.gateId,
        path: '/payload',
      });
    }
    try {
      await sendOperationInteraction(
        operationWorkflowId(configuration.operationId),
        {
          schemaVersion: 'operation-interaction/v1',
          kind: 'gate',
          answer: input.answer,
          payload: input.payload ?? null,
          actorId: input.actorId,
          actorGroups,
        },
        `gate:${input.gateId}`,
      );
    } catch {
      throw new RunManagerError('run_interaction_failed', {
        runId: input.runId,
        operation: 'gate',
      });
    }
  }

  private assertStarted(): void {
    if (this.lifecycle !== 'running') {
      throw new RunManagerError('manager_not_started', { lifecycle: this.lifecycle });
    }
  }

  private requireRunId(value: unknown): string {
    if (!Check(RunIdSchema, value)) {
      throw new RunManagerError('invalid_run_id', { path: '/runId', reason: 'grammar' });
    }
    return value;
  }

  private async hasAdmissionToken(workflowId: string, token: string): Promise<boolean> {
    try {
      const [stored] = await DBOS.retrieveWorkflow(workflowId).getWorkflowInputs<[unknown]>();
      return hasAdmissionToken(stored, token);
    } catch {
      return false;
    }
  }

  private async workflowStatus(runId: string, operation: 'get_run' | 'get_details') {
    try {
      return await DBOS.getWorkflowStatus(runWorkflowId(runId));
    } catch {
      throw new RunManagerError('run_read_failed', { runId, operation });
    }
  }

  private async completedKernelResult(
    runId: string,
    operation: 'get_run' | 'get_details',
  ): Promise<KernelRunResult> {
    try {
      const result = await DBOS.retrieveWorkflow<KernelRunResult>(runWorkflowId(runId)).getResult();
      if (!isKernelRunResult(result, runId)) {
        throw new Error('Completed workflow result violates the public contract.');
      }
      return result;
    } catch {
      throw new RunManagerError('run_read_failed', { runId, operation });
    }
  }

  private async publishedDetails(
    runId: string,
    operation: 'get_run' | 'get_details',
  ): Promise<RunDetails | null> {
    try {
      const details = await DBOS.getEvent<RunDetails>(runWorkflowId(runId), 'revo-run.details', {
        timeoutSeconds: 0,
      });
      if (details !== null && (!Check(RunDetailsSchema, details) || details.runId !== runId)) {
        throw new Error('Persisted run details violate the public contract.');
      }
      return details;
    } catch {
      throw new RunManagerError('run_read_failed', { runId, operation });
    }
  }

  private async assertPersistedRunsCompatible(): Promise<void> {
    const client = await DBOSClient.create({ systemDatabaseUrl: this.options.database.url });
    try {
      let offset = 0;
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- each page must be inspected before continuing startup.
        const workflows = await listCompatibilityPage(client, offset);
        if (workflows === null) {
          return;
        }
        for (const workflow of workflows) {
          assertCompatiblePersistedWorkflow(workflow);
        }
        if (workflows.length < 100) {
          return;
        }
        offset += workflows.length;
      }
    } finally {
      await client.destroy();
    }
  }

  private async listKernelWorkflows(filter: ListRunsFilter): Promise<readonly WorkflowStatus[]> {
    const workflows: WorkflowStatus[] = [];
    let offset = 0;
    try {
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- DBOS pagination is the durable list boundary.
        const page = await DBOS.listWorkflows({
          workflowName: kernelRunWorkflowName,
          offset,
          limit: 100,
          sortDesc: true,
          ...(filter.createdAtFrom === undefined ? {} : { startTime: filter.createdAtFrom }),
          ...(filter.createdAtTo === undefined ? {} : { endTime: filter.createdAtTo }),
        });
        workflows.push(...page);
        if (page.length < 100) {
          return workflows;
        }
        offset += page.length;
      }
    } catch {
      throw new RunManagerError('run_read_failed', { runId: null, operation: 'list_runs' });
    }
  }

  private async eventHighWater(runId: string, operation: 'get_events'): Promise<number | null> {
    try {
      return await DBOS.getEvent<number>(runWorkflowId(runId), runEventHighWaterKey, {
        timeoutSeconds: 0,
      });
    } catch {
      throw new RunManagerError('run_read_failed', { runId, operation });
    }
  }
}
