import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk';

import { scopeReplyTopic } from '../../../src/dbos/dbos-names.js';
import { DbosRunRuntime } from '../../../src/dbos/dbos-run-runtime.js';
import {
  DbosRunEventStream,
  RunEventBudgetExceededError,
} from '../../../src/dbos/streams/run-event-stream.js';
import { runWorkflowId } from '../../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../../src/dbos/workflow-registry.js';
import type { NodeOutput } from '../../../src/index.js';
import { RunManager } from '../../../src/manager/run-manager.js';
import { JsonValueValidator } from '../../../src/validation/json-value.validator.js';
import { recoveryScenarios } from '../../acceptance/scenarios/recovery.scenarios.js';
import { parseRecoveryInstructions } from './effect-recovery-scenario-program.js';
import { recoveryExecutionPlan } from './recovery-execution-plan.fixture.js';
import { RecoveryProcessExecutor } from './recovery-process-executor.js';

type WorkerCommand =
  | {
      readonly kind: 'complete';
      readonly path: string;
      readonly result: { readonly outcome: string; readonly output?: NodeOutput };
    }
  | {
      readonly kind: 'resolveUnknownOutcome';
      readonly attemptId: string;
      readonly actorId: string;
      readonly resolution:
        | {
            readonly kind: 'adoptSuccess';
            readonly outcome: string;
            readonly output?: NodeOutput;
          }
        | { readonly kind: 'markFailed' }
        | { readonly kind: 'retry' };
    }
  | { readonly kind: 'cancelRun'; readonly actorId: string }
  | { readonly kind: 'releaseAdmission' }
  | { readonly kind: 'releaseDecision' }
  | { readonly kind: 'releaseReadiness' };

const environment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const optionalPositiveInteger = (name: string): number | undefined => {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
};

const optionalJson = (name: string): unknown => {
  const value = process.env[name];
  return value === undefined ? undefined : JSON.parse(value);
};

const send = (message: object): void => {
  process.send?.(message);
};

const pauseBeforeFirstIntent = (): void => {
  const runStep = DBOS.runStep.bind(DBOS);
  let paused = false;
  Object.defineProperty(DBOS, 'runStep', {
    configurable: true,
    value: async <Result>(
      callback: () => Promise<Result>,
      config?: StepConfig & { readonly name?: string },
    ): Promise<Result> => {
      if (!paused && config?.name?.startsWith('node-effect-intent:') === true) {
        paused = true;
        send({ kind: 'beforeIntent' });
        return new Promise(() => undefined);
      }
      return runStep(callback, config);
    },
  });
};

let releaseDecision: (() => void) | undefined;

const pauseAfterFirstParallelDecision = (): void => {
  const runStep = DBOS.runStep.bind(DBOS);
  let paused = false;
  Object.defineProperty(DBOS, 'runStep', {
    configurable: true,
    value: async <Result>(
      callback: () => Promise<Result>,
      config?: StepConfig & { readonly name?: string },
    ): Promise<Result> => {
      const result = await runStep(callback, config);
      if (!paused && config?.name?.startsWith('parallel-join-decision:') === true) {
        paused = true;
        send({ kind: 'afterDecision' });
        await new Promise<void>((resolve) => {
          releaseDecision = resolve;
        });
      }
      return result;
    },
  });
};

let releaseReadiness: (() => void) | undefined;
let releaseAdmission: (() => void) | undefined;

const pauseBeforeScopeAdmission = (targetOrdinal: number): void => {
  const sendMessage = DBOS.send.bind(DBOS);
  let admissionOrdinal = 0;
  Object.defineProperty(DBOS, 'send', {
    configurable: true,
    value: async (workflowId: string, message: unknown, topic?: string): Promise<void> => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'scopeAdmission'
      ) {
        admissionOrdinal += 1;
        if (admissionOrdinal === targetOrdinal) {
          send({ kind: 'beforeAdmission' });
          await new Promise<void>((resolve) => {
            releaseAdmission = resolve;
          });
        }
      }
      return sendMessage(workflowId, message, topic);
    },
  });
};

const reportScopeCancellationAcknowledgement = (): void => {
  const sendMessage = DBOS.send.bind(DBOS);
  const receive = DBOS.recv.bind(DBOS);
  let awaitingAcknowledgement = false;
  Object.defineProperty(DBOS, 'send', {
    configurable: true,
    value: async (workflowId: string, message: unknown, topic?: string): Promise<void> => {
      await sendMessage(workflowId, message, topic);
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'scopeCancellation'
      ) {
        awaitingAcknowledgement = true;
      }
    },
  });
  Object.defineProperty(DBOS, 'recv', {
    configurable: true,
    value: async (topic: string, options?: { readonly timeoutSeconds?: number }) => {
      const result = await receive(topic, options);
      if (awaitingAcknowledgement && topic === scopeReplyTopic && result !== null) {
        awaitingAcknowledgement = false;
        send({ kind: 'scopeCancellationAcknowledged' });
      }
      return result;
    },
  });
};

const pauseBeforeScopeReadiness = (targetOrdinal: number): void => {
  const sendMessage = DBOS.send.bind(DBOS);
  let readinessOrdinal = 0;
  Object.defineProperty(DBOS, 'send', {
    configurable: true,
    value: async (workflowId: string, message: unknown, topic?: string): Promise<void> => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'scopeReady'
      ) {
        readinessOrdinal += 1;
        if (readinessOrdinal === targetOrdinal) {
          send({ kind: 'beforeReadiness' });
          await new Promise<void>((resolve) => {
            releaseReadiness = resolve;
          });
        }
      }
      return sendMessage(workflowId, message, topic);
    },
  });
};

const failCommandEventBudget = (): void => {
  const candidate: unknown = Object.getOwnPropertyDescriptor(
    DbosRunEventStream.prototype,
    'append',
  )?.value;
  if (typeof candidate !== 'function') {
    throw new Error('Run event append method is unavailable.');
  }
  DbosRunEventStream.prototype.append = function (event) {
    if (event.type === 'runCommand.accepted' || event.type === 'runCommand.rejected') {
      throw new RunEventBudgetExceededError('maximum_run_event_bytes_exceeded');
    }
    const result: unknown = Reflect.apply(candidate, this, [event]);
    if (!(result instanceof Promise)) {
      throw new Error('Run event append did not return a promise.');
    }
    return result;
  };
};

const scenario = environment('REVO_RUN_TEST_SCENARIO');
const mode = environment('REVO_RUN_TEST_MODE');
if (process.env.REVO_RUN_TEST_PAUSE_BEFORE_INTENT === 'true' && mode === 'start') {
  pauseBeforeFirstIntent();
}
const admissionPauseOrdinal = optionalPositiveInteger('REVO_RUN_TEST_PAUSE_BEFORE_ADMISSION');
if (admissionPauseOrdinal !== undefined && mode === 'start') {
  pauseBeforeScopeAdmission(admissionPauseOrdinal);
}
if (process.env.REVO_RUN_TEST_PAUSE_AFTER_DECISION === 'true' && mode === 'start') {
  pauseAfterFirstParallelDecision();
}
const readinessPauseOrdinal = optionalPositiveInteger('REVO_RUN_TEST_PAUSE_BEFORE_READINESS');
if (readinessPauseOrdinal !== undefined && mode === 'start') {
  pauseBeforeScopeReadiness(readinessPauseOrdinal);
}
if (process.env.REVO_RUN_TEST_FAIL_COMMAND_EVENT_BUDGET === 'true') {
  failCommandEventBudget();
}
reportScopeCancellationAcknowledgement();
const unvalidatedInstructions = optionalJson('REVO_RUN_TEST_RECONCILIATIONS');
const instructions =
  unvalidatedInstructions === undefined ? [] : parseRecoveryInstructions(unvalidatedInstructions);
const acceptanceScenario = recoveryScenarios.find(({ intentId }) => intentId === scenario);
const plan =
  acceptanceScenario?.plan ??
  recoveryExecutionPlan(scenario, optionalPositiveInteger('REVO_RUN_TEST_RETRY_DELAY_MS'));
const executor = new RecoveryProcessExecutor({
  scenario,
  instructions,
  instructionsConfigured: unvalidatedInstructions !== undefined,
  holdReconciliation: process.env.REVO_RUN_TEST_HOLD_RECONCILIATION === 'true',
  ignoreAbort: process.env.REVO_RUN_TEST_IGNORE_ABORT === 'true',
  report: send,
});
const workflows = new WorkflowRegistry();
const manager = new RunManager(
  new DbosRunRuntime(environment('REVO_RUN_TEST_DATABASE_URL'), executor, workflows),
);
const runId = environment('REVO_RUN_TEST_RUN_ID');
const checkpointed = new Set<string>();
const observedAttemptStatuses = new Set<string>();
const observedParallelJoins = new Set<string>();

const handleCommand = async (message: WorkerCommand): Promise<void> => {
  if (message.kind === 'releaseAdmission') {
    releaseAdmission?.();
    releaseAdmission = undefined;
    return;
  }
  if (message.kind === 'releaseDecision') {
    releaseDecision?.();
    releaseDecision = undefined;
    return;
  }
  if (message.kind === 'releaseReadiness') {
    releaseReadiness?.();
    releaseReadiness = undefined;
    return;
  }
  if (message.kind === 'complete') {
    try {
      executor.complete(message.path, message.result);
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return;
  }
  try {
    const commandReceipt =
      message.kind === 'cancelRun'
        ? await manager.cancelRun({ runId, actorId: message.actorId })
        : await manager.resolveUnknownOutcome({
            runId,
            attemptId: message.attemptId,
            actorId: message.actorId,
            resolution: message.resolution,
          });
    send({ kind: 'commandReceipt', commandReceipt });
  } catch (error) {
    send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

process.on('message', (message: WorkerCommand) => {
  void handleCommand(message);
});

await manager.start();
if (mode === 'start') {
  const input = optionalJson('REVO_RUN_TEST_INPUT');
  if (input !== undefined && !JsonValueValidator.Check(input)) {
    throw new Error('REVO_RUN_TEST_INPUT must be a JSON value.');
  }
  await manager.startRun({ runId, executionPlan: plan, input: input ?? null });
}
send({ kind: 'ready' });

const watchTerminalRun = async (): Promise<void> => {
  const details = await manager.getRunDetails(runId);
  for (const execution of details?.nodeInstances ?? []) {
    const path = execution.displayPath;
    if (!checkpointed.has(path)) {
      checkpointed.add(path);
      send({ kind: 'checkpointed', path });
    }
    const observation = `${path}:${execution.status}`;
    if (!observedAttemptStatuses.has(observation)) {
      observedAttemptStatuses.add(observation);
      send({ kind: 'attemptObserved', path, status: execution.status });
    }
  }
  for (const join of details?.parallelJoins ?? []) {
    const observation = `${join.scopeId}:${join.nodeInstanceId}`;
    if (!observedParallelJoins.has(observation)) {
      observedParallelJoins.add(observation);
      send({
        kind: 'parallelObserved',
        remaining: join.remaining,
        observedBranchKeys: join.observedBranchKeys,
        skippedBranchKeys: join.skippedBranchKeys,
      });
    }
  }

  const run = await manager.getRun(runId);
  if (run !== undefined && run.status !== 'pending' && run.status !== 'running') {
    const rootStatus = await DBOS.getWorkflowStatus(runWorkflowId(runId));
    send({ kind: 'terminal', status: run.status });
    send({
      kind: 'details',
      attempts: (details?.attempts ?? []).map((attempt) => ({
        ordinal: attempt.ordinal,
        status: attempt.status,
        ...(attempt.status === 'completed' && attempt.output !== undefined
          ? { output: attempt.output }
          : {}),
        ...(attempt.status === 'outcomeUnknown' ? { recovery: attempt.recovery } : {}),
      })),
      commands: details?.commands ?? [],
      nodeStatuses: (details?.nodeInstances ?? []).map(({ displayPath, status }) => ({
        path: displayPath,
        status,
      })),
      ...('result' in run
        ? run.result.output === undefined
          ? {}
          : { runOutput: run.result.output }
        : {}),
      ...(rootStatus?.workflowName === undefined ? {} : { workflowName: rootStatus.workflowName }),
    });
    const events = [];
    for await (const event of manager.subscribeRunEvents(runId)) {
      events.push(event);
    }
    send({
      kind: 'events',
      cursors: events.map(({ cursor }) => cursor),
      events: events.map(({ type, data }) => ({ type, data })),
      types: events.map(({ type }) => type),
    });
    await manager.stop();
    send({ kind: 'stopped' });
    process.disconnect();
    return;
  }
  setTimeout(() => void watchTerminalRun(), 25);
};

void watchTerminalRun();
