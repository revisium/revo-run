import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk';

import type {
  NodeOutput,
  RunExecutor,
  RunExecutorContext,
  RunExecutorRequest,
  RunExecutorReconciliationResult,
  RunExecutorResult,
} from '../../../src/index.js';
import { createRunManager } from '../../../src/index.js';
import { JsonValueValidator } from '../../../src/validation/json-value.validator.js';
import { recoveryScenarios } from '../../acceptance/scenarios/recovery.scenarios.js';
import {
  parseRecoveryInstructions,
  type RecoveryInstruction,
} from './effect-recovery-scenario-program.js';
import { recoveryExecutionPlan } from './recovery-execution-plan.fixture.js';

type WorkerCommand = {
  readonly kind: 'complete';
  readonly path: string;
  readonly result: { readonly outcome: string; readonly output?: NodeOutput };
};

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

class ProcessRunExecutor implements RunExecutor {
  private readonly pending = new Map<string, Array<(result: RunExecutorResult) => void>>();
  private readonly instructions: RecoveryInstruction[];
  private readonly instructionsConfigured: boolean;
  private readonly holdReconciliation: boolean;
  private readonly scenario: string;

  constructor(
    scenario: string,
    instructions: readonly RecoveryInstruction[],
    instructionsConfigured: boolean,
    holdReconciliation: boolean,
  ) {
    this.scenario = scenario;
    this.instructions = [...instructions];
    this.instructionsConfigured = instructionsConfigured;
    this.holdReconciliation = holdReconciliation;
  }

  execute(request: RunExecutorRequest, context: RunExecutorContext): Promise<RunExecutorResult> {
    send({
      kind: 'dispatched',
      path: request.displayPath,
      attemptId: request.attemptId,
      attemptOrdinal: request.attemptOrdinal,
      nodeInstanceId: request.nodeInstanceId,
    });
    if (this.scenario === 'retry' && request.attemptOrdinal === 1) {
      return Promise.resolve({
        kind: 'failed',
        error: { code: 'rate_limited', message: 'retry later' },
      });
    }
    if (this.scenario === 'timeout' && request.displayPath === 'main/work') {
      return new Promise(() => {
        context.signal.addEventListener('abort', () => {
          send({ kind: 'timeoutSignalled', path: request.displayPath });
        });
      });
    }

    return new Promise((resolve) => {
      const pending = this.pending.get(request.displayPath) ?? [];
      pending.push(resolve);
      this.pending.set(request.displayPath, pending);
    });
  }

  reconcile(
    request: RunExecutorRequest,
    attemptId: string,
  ): Promise<RunExecutorReconciliationResult> {
    if (attemptId !== request.attemptId) {
      throw new Error('Reconciliation received another attempt identity.');
    }
    send({
      kind: 'reconciled',
      path: request.displayPath,
      attemptId,
      attemptOrdinal: request.attemptOrdinal,
    });
    if (this.holdReconciliation) {
      return new Promise(() => undefined);
    }
    const instruction = this.instructions.shift();
    if (instruction === undefined) {
      if (this.instructionsConfigured) {
        throw new Error('No declared reconciliation instruction remains.');
      }
      return Promise.resolve({ kind: 'effectNotFound' });
    }
    switch (instruction.kind) {
      case 'effectCompleted':
        return Promise.resolve({
          kind: 'effectCompleted',
          result: {
            kind: 'completed',
            outcome: 'completed',
            ...(instruction.output === undefined ? {} : { output: instruction.output }),
          },
        });
      case 'effectFailed':
        return Promise.resolve({
          kind: 'effectFailed',
          error: { code: 'provider_failed', message: 'Provider reported a failed effect.' },
        });
      case 'effectNotFound':
        return Promise.resolve({ kind: 'effectNotFound' });
      case 'outcomeUnknown':
        return Promise.resolve({ kind: 'outcomeUnknown' });
      case 'reconciliationFailed':
        return Promise.reject(new Error('Reconciliation unavailable.'));
    }
    throw new Error('Recovery instruction is unsupported.');
  }

  complete(path: string, result: { readonly outcome: string; readonly output?: NodeOutput }): void {
    const resolve = this.pending.get(path)?.shift();
    if (resolve === undefined) {
      throw new Error(`Execution ${path} is not pending.`);
    }
    resolve({ kind: 'completed', ...result });
  }
}

const scenario = environment('REVO_RUN_TEST_SCENARIO');
const mode = environment('REVO_RUN_TEST_MODE');
if (process.env.REVO_RUN_TEST_PAUSE_BEFORE_INTENT === 'true' && mode === 'start') {
  pauseBeforeFirstIntent();
}
const unvalidatedInstructions = optionalJson('REVO_RUN_TEST_RECONCILIATIONS');
const instructions =
  unvalidatedInstructions === undefined ? [] : parseRecoveryInstructions(unvalidatedInstructions);
const acceptanceScenario = recoveryScenarios.find(({ intentId }) => intentId === scenario);
const plan =
  acceptanceScenario?.plan ??
  recoveryExecutionPlan(scenario, optionalPositiveInteger('REVO_RUN_TEST_RETRY_DELAY_MS'));
const executor = new ProcessRunExecutor(
  scenario,
  instructions,
  unvalidatedInstructions !== undefined,
  process.env.REVO_RUN_TEST_HOLD_RECONCILIATION === 'true',
);
const manager = createRunManager({
  database: { url: environment('REVO_RUN_TEST_DATABASE_URL') },
  executor,
});
const runId = environment('REVO_RUN_TEST_RUN_ID');
const checkpointed = new Set<string>();

process.on('message', (message: WorkerCommand) => {
  if (message.kind === 'complete') {
    try {
      executor.complete(message.path, message.result);
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
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
  }

  const run = await manager.getRun(runId);
  if (run !== undefined && run.status !== 'pending' && run.status !== 'running') {
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
