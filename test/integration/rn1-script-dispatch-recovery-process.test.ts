import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type { KernelRunResult } from '../../src/dbos/kernel-run-workflow.js';
import { operationWorkflowId, runWorkflowId } from '../../src/dbos/workflow-id.js';
import { attemptDispatchArbitrationWorkflowId } from '../../src/operations/identities.js';
import { forkTestDbosProcess } from '../support/process/fork-test-dbos-process.js';
import {
  assertRecoveryObservation,
  recoveryExpectedString,
  recoveryScenario,
} from '../support/rn1-recovery-matrix.js';
import { testDatabaseUrl } from '../support/test-environment.js';

type WorkerMode = 'start' | 'recover' | 'recover-closed';
type FaultPoint =
  | 'after-arbitration-start-before-result'
  | 'after-script-dispatch-intent'
  | 'before-script-dispatch-intent-commit'
  | 'before-script-provider-decision'
  | 'before-pre-dispatch-cancellation-relay'
  | 'after-script-acceptance'
  | 'after-script-provider-step'
  | 'after-script-reconciliation'
  | 'after-script-terminal-persisted'
  | 'after-kernel-advance'
  | 'before-coordinator-receive';

interface WorkerMessage {
  readonly kind: 'cancel' | 'error' | 'execute' | 'fault' | 'launched' | 'reconcile' | 'terminal';
  readonly point?: FaultPoint;
  readonly executionId?: string;
  readonly attemptId?: string;
  readonly message?: string;
  readonly result?: unknown;
  readonly eventTypes?: readonly string[];
  readonly scriptEventNames?: readonly string[];
  readonly workflowId?: string;
}

interface WaitableWorker {
  readonly messages: readonly WorkerMessage[];
  readonly process: {
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
  };
}

const workerPath = fileURLToPath(
  new URL('../support/process/rn1-script-dispatch-recovery-worker.ts', import.meta.url),
);

const startWorker = (
  runId: string,
  applicationVersion: string,
  mode: WorkerMode,
  faultPoints: readonly FaultPoint[] = [],
  pipelineMode?: 'two' | 'parallel',
  reconciliationMode?: 'notFound',
  cancellationMode?: 'notFound',
) => {
  const process = forkTestDbosProcess(workerPath, {
    applicationVersion,
    env: {
      RN1_TEST_DATABASE_URL: testDatabaseUrl(),
      RN1_TEST_RUN_ID: runId,
      RN1_TEST_MODE: mode,
      ...(faultPoints.length === 0 ? {} : { RN1_TEST_FAULT_POINTS: faultPoints.join(',') }),
      ...(pipelineMode === undefined ? {} : { RN1_TEST_PIPELINE: pipelineMode }),
      ...(reconciliationMode === undefined ? {} : { RN1_TEST_RECONCILE: reconciliationMode }),
      ...(cancellationMode === undefined ? {} : { RN1_TEST_CANCEL: cancellationMode }),
    },
  });
  const messages: WorkerMessage[] = [];
  process.on('message', (message: WorkerMessage) => messages.push(message));
  return { messages, process };
};

const waitFor = async (
  child: WaitableWorker,
  kind: WorkerMessage['kind'],
  timeoutMs = 10_000,
): Promise<WorkerMessage> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = child.messages.find((message) => message.kind === 'error');
    if (error !== undefined) {
      throw new Error(`Recovery worker failed: ${error.message ?? 'unknown error'}`);
    }
    const message = child.messages.find((candidate) => candidate.kind === kind);
    if (message !== undefined) {
      return message;
    }
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(
        `Recovery worker exited before ${kind}: ${child.process.exitCode ?? child.process.signalCode}.`,
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded IPC polling is the process-test protocol.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Recovery worker did not emit ${kind}.`);
};

const waitForFault = async (
  child: ReturnType<typeof startWorker>,
  point: FaultPoint,
): Promise<WorkerMessage> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const error = child.messages.find((message) => message.kind === 'error');
    if (error !== undefined) {
      throw new Error(`Recovery worker failed: ${error.message ?? 'unknown error'}`);
    }
    const fault = child.messages.find(
      (message) => message.kind === 'fault' && message.point === point,
    );
    if (fault !== undefined) {
      return fault;
    }
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`Recovery worker exited before ${point}.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded IPC polling is the process-test protocol.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Recovery worker did not emit ${point}.`);
};

const kill = async (child: ReturnType<typeof startWorker> | undefined): Promise<void> => {
  if (
    child === undefined ||
    child.process.killed ||
    child.process.exitCode !== null ||
    child.process.signalCode !== null
  ) {
    return;
  }
  child.process.kill('SIGKILL');
  await once(child.process, 'exit');
};

const callMessages = (
  ...workers: readonly (ReturnType<typeof startWorker> | undefined)[]
): readonly WorkerMessage[] =>
  workers.flatMap(
    (child) =>
      child?.messages.filter(
        (message) =>
          message.kind === 'execute' || message.kind === 'reconcile' || message.kind === 'cancel',
      ) ?? [],
  );

const operationStepNames = async (operationId: string): Promise<readonly string[]> => {
  DBOS.setConfig({
    name: 'revo-run-script-dispatch-recovery-inspection',
    systemDatabaseUrl: testDatabaseUrl(),
  });
  await DBOS.launch();
  try {
    const steps = await DBOS.listWorkflowSteps(operationWorkflowId(operationId));
    if (steps === undefined) {
      throw new Error('Expected durable operation workflow steps.');
    }
    return steps.map(({ name }) => name);
  } finally {
    await DBOS.shutdown();
  }
};

const withController = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
  DBOS.setConfig({ name, systemDatabaseUrl: testDatabaseUrl() });
  await DBOS.launch();
  try {
    return await action();
  } finally {
    await DBOS.shutdown();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rootAttempt = (
  result: unknown,
): Readonly<{ readonly operationId: string; readonly attemptId: string }> => {
  if (
    !isRecord(result) ||
    !isRecord(result.details) ||
    !('activities' in result.details) ||
    !Array.isArray(result.details.activities) ||
    !('attempts' in result.details) ||
    !Array.isArray(result.details.attempts)
  ) {
    throw new Error('Expected the worker to return a durable kernel result.');
  }
  const activity: unknown = result.details.activities[0];
  const attempt: unknown = result.details.attempts[0];
  if (
    !isRecord(activity) ||
    !('operationId' in activity) ||
    typeof activity.operationId !== 'string' ||
    !isRecord(attempt) ||
    !('attemptId' in attempt) ||
    typeof attempt.attemptId !== 'string'
  ) {
    throw new Error('Expected a durable script operation and attempt.');
  }
  return { operationId: activity.operationId, attemptId: attempt.attemptId };
};

const activityStatuses = (message: WorkerMessage): readonly string[] => {
  if (
    !isRecord(message.result) ||
    !isRecord(message.result.details) ||
    !Array.isArray(message.result.details.activities)
  ) {
    throw new Error('Expected durable activity observations from the recovery worker.');
  }
  return message.result.details.activities.map((activity) =>
    isRecord(activity) && typeof activity.status === 'string' ? activity.status : 'invalid',
  );
};

const terminalStatus = (message: WorkerMessage): string => {
  if (!isRecord(message.result) || !isRecord(message.result.snapshot)) {
    throw new Error('Expected a terminal worker result with a snapshot.');
  }
  if (typeof message.result.snapshot.status !== 'string') {
    throw new Error('Expected a terminal worker result status.');
  }
  return message.result.snapshot.status;
};

const terminalRecoveryCount = (message: WorkerMessage): number => {
  if (!isRecord(message.result) || !isRecord(message.result.details)) {
    throw new Error('Expected a terminal worker result with details.');
  }
  const recovery = message.result.details.recovery;
  if (!Array.isArray(recovery)) {
    throw new Error('Expected a terminal worker result recovery list.');
  }
  return recovery.length;
};

const recoveryObservation = (
  terminal: WorkerMessage,
  calls: readonly WorkerMessage[],
  prohibited: Readonly<Record<string, boolean>>,
) => ({
  state: 'terminal',
  status: terminalStatus(terminal),
  events: {
    script: terminal.scriptEventNames?.filter((name) => name !== 'revo.script.started').length ?? 0,
    kernel: terminal.eventTypes?.filter((type) => type === 'run.terminal').length ?? 0,
  },
  calls: {
    execute: calls.filter(({ kind }) => kind === 'execute').length,
    reconcile: calls.filter(({ kind }) => kind === 'reconcile').length,
    cancel: calls.filter(({ kind }) => kind === 'cancel').length,
  },
  prohibited,
});

describe('RN1 script dispatch recovery', () => {
  let first: ReturnType<typeof startWorker> | undefined;
  let recovered: ReturnType<typeof startWorker> | undefined;

  afterEach(async () => {
    await kill(first);
    await kill(recovered);
  });

  it('retains a terminal IPC message that was buffered before a clean worker exit', async () => {
    const terminal: WorkerMessage = {
      kind: 'terminal',
      result: { snapshot: { status: 'succeeded' } },
    };
    const child = {
      messages: [terminal],
      process: { exitCode: 0, signalCode: null },
    };

    await expect(waitFor(child, 'terminal')).resolves.toBe(terminal);
  });

  it('reconciles the same accepted script identity after SIGKILL before the provider step commits', async () => {
    const scenario = recoveryScenario('D3');
    const runId = `rn1-script-accepted-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['after-script-acceptance']);

    await expect(waitFor(first, 'execute')).resolves.toMatchObject({ kind: 'execute' });
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      kind: 'fault',
      point: 'after-script-acceptance',
    });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({
      kind: 'terminal',
      result: { snapshot: { status: recoveryExpectedString(scenario, 'status') } },
    });

    const calls = callMessages(first, recovered);
    assertRecoveryObservation(
      scenario,
      recoveryObservation(terminal, calls, {
        preDispatchCancellation:
          terminal.scriptEventNames?.includes('revo.script.cancelled') ?? false,
        newAttempt: new Set(calls.map(({ attemptId }) => attemptId)).size > 1,
      }),
    );
    expect(calls[1]).toMatchObject({
      executionId: calls[0]?.executionId,
      attemptId: calls[0]?.attemptId,
    });
  }, 30_000);

  it('recovers after the arbitration child stored its input and status before the caller observed its zero-step result', async () => {
    const runId = `rn1-script-arbitration-input-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', [
      'after-arbitration-start-before-result',
    ]);

    const fault = await waitForFault(first, 'after-arbitration-start-before-result');
    const arbitrationWorkflowId = fault.workflowId;
    if (arbitrationWorkflowId === undefined) {
      throw new Error('Expected the stored arbitration workflow identity.');
    }
    await withController(`revo-run-arbitration-input-inspection-${randomUUID()}`, async () => {
      const gate = DBOS.retrieveWorkflow(arbitrationWorkflowId);
      const [storedInput] = await gate.getWorkflowInputs<[unknown]>();
      expect(storedInput).toMatchObject({
        schemaVersion: 'attempt-dispatch-arbitration/v1',
        winner: 'dispatch_won',
      });
      await expect(DBOS.getWorkflowStatus(arbitrationWorkflowId)).resolves.toMatchObject({
        workflowName: 'revo-run.attempt-dispatch-arbitration/v1',
      });
    });
    expect(callMessages(first)).toStrictEqual([]);
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    await expect(waitFor(recovered, 'terminal')).resolves.toMatchObject({
      result: { snapshot: { status: 'succeeded' } },
    });
    expect(callMessages(first, recovered).map(({ kind }) => kind)).toStrictEqual(['reconcile']);
  }, 30_000);

  it('rebuilds an uncommitted dispatch intent with a fresh baseline before it executes', async () => {
    const runId = `rn1-script-before-intent-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', [
      'before-script-dispatch-intent-commit',
    ]);

    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'before-script-dispatch-intent-commit',
    });
    expect(callMessages(first)).toStrictEqual([]);
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    await expect(waitFor(recovered, 'terminal')).resolves.toMatchObject({
      result: { snapshot: { status: 'succeeded' } },
    });
    const calls = callMessages(first, recovered);
    expect(calls.map(({ kind }) => kind)).toStrictEqual(['execute']);
    const operationId = calls[0]?.executionId;
    if (operationId === undefined || calls[0]?.attemptId === undefined) {
      throw new Error('Expected the first dispatch identity.');
    }
    const steps = await operationStepNames(operationId);
    expect(steps).toContain(`script-dispatch-intent:${calls[0].attemptId}`);
    expect(steps).toContain(`script-provider-dispatch:${calls[0].attemptId}`);
    expect(steps).not.toContain('DBOS.getWorkflowStatus');
  }, 30_000);

  it('reconciles instead of dispatching after a durable intent but before provider work', async () => {
    const runId = `rn1-script-after-intent-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['before-script-provider-decision']);

    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'before-script-provider-decision',
    });
    expect(callMessages(first)).toStrictEqual([]);
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    await expect(waitFor(recovered, 'terminal')).resolves.toMatchObject({
      result: { snapshot: { status: 'succeeded' } },
    });
    expect(callMessages(first, recovered).map(({ kind }) => kind)).toStrictEqual(['reconcile']);
  }, 30_000);

  it('gives proven notFound one fresh guarded dispatch intent and never reuses the old one', async () => {
    const runId = `rn1-script-not-found-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['after-script-dispatch-intent']);
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'after-script-dispatch-intent',
    });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover', [], undefined, 'notFound');
    await expect(waitFor(recovered, 'terminal')).resolves.toMatchObject({
      result: { snapshot: { status: 'succeeded' } },
    });
    const calls = callMessages(first, recovered);
    expect(calls.map(({ kind }) => kind)).toStrictEqual(['reconcile', 'execute']);
    const operationId = calls[1]?.executionId;
    const currentAttemptId = calls[1]?.attemptId;
    if (operationId === undefined || currentAttemptId === undefined) {
      throw new Error('Expected the fresh guarded dispatch identity.');
    }
    const steps = await operationStepNames(operationId);
    expect(steps).toContain(`script-reexecute-dispatch-intent:${currentAttemptId}`);
    expect(steps).toContain(`script-reexecute-provider:${currentAttemptId}`);
    expect(steps).not.toContain(`script-reexecute:${currentAttemptId}`);
  }, 30_000);

  it('never redispatches when repeated recovery interrupts reconciliation', async () => {
    const runId = `rn1-script-repeat-reconcile-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['before-script-provider-decision']);
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'before-script-provider-decision',
    });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover', ['after-script-reconciliation']);
    await expect(waitFor(recovered, 'reconcile')).resolves.toMatchObject({ kind: 'reconcile' });
    await expect(waitFor(recovered, 'fault')).resolves.toMatchObject({
      point: 'after-script-reconciliation',
    });
    await kill(recovered);

    const resumed = startWorker(runId, applicationVersion, 'recover');
    try {
      await expect(waitFor(resumed, 'terminal')).resolves.toMatchObject({
        result: { snapshot: { status: 'succeeded' } },
      });
      const calls = callMessages(first, recovered, resumed);
      expect(calls.map(({ kind }) => kind)).toStrictEqual(['reconcile', 'reconcile']);
      expect(calls[1]).toMatchObject({
        executionId: calls[0]?.executionId,
        attemptId: calls[0]?.attemptId,
      });
    } finally {
      await kill(resumed);
    }
  }, 30_000);

  it('replays a completed provider step without another execute or reconciliation call', async () => {
    const runId = `rn1-script-completed-step-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start');
    await expect(waitFor(first, 'terminal')).resolves.toMatchObject({
      result: { snapshot: { status: 'succeeded' } },
    });

    recovered = startWorker(runId, applicationVersion, 'recover');
    await expect(waitFor(recovered, 'terminal')).resolves.toMatchObject({
      result: { snapshot: { status: 'succeeded' } },
    });
    expect(callMessages(first, recovered).map(({ kind }) => kind)).toStrictEqual(['execute']);
  }, 30_000);

  it('holds a recovered provider decision behind the readiness fence without host calls', async () => {
    const runId = `rn1-script-closed-fence-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['before-script-provider-decision']);
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'before-script-provider-decision',
    });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover-closed');
    await expect(waitFor(recovered, 'launched')).resolves.toMatchObject({ kind: 'launched' });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(callMessages(recovered)).toStrictEqual([]);
  }, 30_000);

  it('preserves a sealed terminal pair once while recovery resumes the kernel transition', async () => {
    const scenario = recoveryScenario('D4');
    const runId = `rn1-script-terminal-pair-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['after-script-terminal-persisted']);
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'after-script-terminal-persisted',
    });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({
      result: { snapshot: { status: recoveryExpectedString(scenario, 'status') } },
    });
    const calls = callMessages(first, recovered);
    assertRecoveryObservation(
      scenario,
      recoveryObservation(terminal, calls, {
        providerReexecute: calls.filter(({ kind }) => kind === 'execute').length > 1,
        terminalPairSplit:
          terminal.scriptEventNames?.filter(
            (name) => name === recoveryExpectedString(scenario, 'terminalEventName'),
          ).length !== 1,
      }),
    );
  }, 30_000);

  it('continues only the next outbox after a stored transition and does not repeat the first one', async () => {
    const scenario = recoveryScenario('D5');
    const runId = `rn1-script-next-outbox-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['after-kernel-advance'], 'two');
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({ point: 'after-kernel-advance' });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover', [], 'two');
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({
      result: { snapshot: { status: recoveryExpectedString(scenario, 'status') } },
    });
    const calls = callMessages(first, recovered);
    const terminalTransitions =
      terminal.eventTypes?.filter((type) => type === 'run.terminal') ?? [];
    expect([...new Set(calls.map(({ executionId }) => executionId))]).toHaveLength(2);
    assertRecoveryObservation(
      scenario,
      recoveryObservation(terminal, calls, {
        providerReexecute: calls.filter(({ kind }) => kind === 'execute').length > 2,
        duplicateKernelTransition: terminalTransitions.length > 1,
      }),
    );
  }, 30_000);

  it('drains a committed live relay once after child death before root receipt', async () => {
    const scenario = recoveryScenario('D8');
    const runId = `rn1-script-live-relay-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', [
      'after-script-provider-step',
      'before-coordinator-receive',
    ]);
    await expect(waitFor(first, 'execute')).resolves.toMatchObject({ kind: 'execute' });
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({ kind: 'fault' });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({
      result: { snapshot: { status: recoveryExpectedString(scenario, 'status') } },
    });
    const calls = callMessages(first, recovered);
    assertRecoveryObservation(
      scenario,
      recoveryObservation(terminal, calls, {
        eventResendReexecutesHandler: calls.filter(({ kind }) => kind === 'execute').length > 1,
        liveEventProvesTerminal:
          !terminal.scriptEventNames?.includes('revo.script.started') ||
          !terminal.scriptEventNames?.some((name) => name === 'revo.script.succeeded'),
      }),
    );
  }, 30_000);

  it('cancels before arbitration without a provider call or recovery', async () => {
    const scenario = recoveryScenario('D2');
    const runId = `rn1-script-cancel-won-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['after-script-dispatch-intent']);
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'after-script-dispatch-intent',
    });
    const active = first;
    if (active === undefined) {
      throw new Error('Expected the cancellation race worker.');
    }

    const result = await withController(`revo-run-cancel-won-${randomUUID()}`, async () => {
      await DBOS.send(
        runWorkflowId(runId),
        { schemaVersion: 'run-cancellation-request/v1', actorId: 'operator-race' },
        'revo-run.coordinator',
        `cancel:${runId}`,
      );
      return await waitFor(active, 'terminal');
    });

    const calls = callMessages(first);
    expect(result.result).toMatchObject({
      snapshot: { status: recoveryExpectedString(scenario, 'status') },
      details: { recovery: [] },
    });
    assertRecoveryObservation(
      scenario,
      recoveryObservation(result, calls, {
        newAttempt: new Set(calls.map(({ attemptId }) => attemptId)).size > 1,
        terminalRecoveryEvent: terminalRecoveryCount(result) > 0,
      }),
    );
    const attempt = rootAttempt(result.result);
    await withController(`revo-run-dispatch-claim-inspection-${randomUUID()}`, async () => {
      // The gate is a child of this run and is only inspected, never deleted independently.
      const gate = DBOS.retrieveWorkflow(
        attemptDispatchArbitrationWorkflowId(attempt.operationId, attempt.attemptId),
      );
      await expect(gate.getResult()).resolves.toMatchObject({ winner: 'cancel_won' });
    });
  }, 30_000);

  it('replays a cancel_won gate after SIGKILL before the root pre-dispatch relay', async () => {
    const runId = `rn1-script-cancel-relay-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', [
      'after-script-dispatch-intent',
      'before-pre-dispatch-cancellation-relay',
    ]);
    await expect(waitForFault(first, 'after-script-dispatch-intent')).resolves.toMatchObject({
      point: 'after-script-dispatch-intent',
    });

    const active = first;
    if (active === undefined) {
      throw new Error('Expected the pre-dispatch cancellation worker.');
    }
    await withController(`revo-run-cancel-relay-${randomUUID()}`, async () => {
      await DBOS.send(
        runWorkflowId(runId),
        { schemaVersion: 'run-cancellation-request/v1', actorId: 'operator-race' },
        'revo-run.coordinator',
        `cancel:${runId}`,
      );
      await expect(
        waitForFault(active, 'before-pre-dispatch-cancellation-relay'),
      ).resolves.toMatchObject({ point: 'before-pre-dispatch-cancellation-relay' });
    });
    expect(callMessages(first)).toStrictEqual([]);
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({
      result: { snapshot: { status: 'cancelled' }, details: { recovery: [] } },
    });
    expect(callMessages(first, recovered).map(({ kind }) => kind)).toStrictEqual([]);
    const stableAttempt = rootAttempt(terminal.result);
    await withController(`revo-run-cancel-relay-inspection-${randomUUID()}`, async () => {
      const gate = DBOS.retrieveWorkflow(
        attemptDispatchArbitrationWorkflowId(stableAttempt.operationId, stableAttempt.attemptId),
      );
      await expect(gate.getResult()).resolves.toMatchObject({ winner: 'cancel_won' });
    });
  }, 30_000);

  it('reconciles the same root-operation attempt after SIGKILL before its provider step', async () => {
    const runId = `rn1-script-claim-restart-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', ['before-script-provider-decision']);
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'before-script-provider-decision',
    });
    expect(callMessages(first)).toStrictEqual([]);
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({ result: { snapshot: { status: 'succeeded' } } });
    const calls = callMessages(first, recovered);
    expect(calls.map(({ kind }) => kind)).toStrictEqual(['reconcile']);
    const executed = calls[0];
    const executionId = executed?.executionId;
    const currentAttemptId = executed?.attemptId;
    if (executionId === undefined || currentAttemptId === undefined) {
      throw new Error('Expected the recovered operation identity.');
    }
    await withController(`revo-run-claim-restart-inspection-${randomUUID()}`, async () => {
      const gate = DBOS.retrieveWorkflow(
        attemptDispatchArbitrationWorkflowId(executionId, currentAttemptId),
      );
      await expect(gate.getResult()).resolves.toMatchObject({ winner: 'dispatch_won' });
    });
  }, 30_000);

  it('keeps dispatch_won through cancellation notFound, then reconciles the same attempt after SIGKILL', async () => {
    const runId = `rn1-script-dispatch-won-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(
      runId,
      applicationVersion,
      'start',
      ['before-script-provider-decision'],
      undefined,
      undefined,
      'notFound',
    );
    await expect(waitFor(first, 'fault')).resolves.toMatchObject({
      point: 'before-script-provider-decision',
    });
    const active = first;
    if (active === undefined) {
      throw new Error('Expected the dispatch race worker.');
    }

    await withController(`revo-run-dispatch-won-cancel-${randomUUID()}`, async () => {
      await DBOS.send(
        runWorkflowId(runId),
        { schemaVersion: 'run-cancellation-request/v1', actorId: 'operator-race' },
        'revo-run.coordinator',
        `cancel:${runId}`,
      );
      await expect(waitFor(active, 'cancel')).resolves.toMatchObject({
        kind: 'cancel',
      });
      await expect
        .poll(
          async () =>
            (
              await DBOS.getEvent<KernelRunResult['details']>(
                runWorkflowId(runId),
                'revo-run.details',
                { timeoutSeconds: 0 },
              )
            )?.status,
          { timeout: 10_000, interval: 20 },
        )
        .toBe('recovery_required');
    });
    await kill(first);

    recovered = startWorker(runId, applicationVersion, 'recover');
    const terminal = await waitFor(recovered, 'terminal');
    expect(terminal).toMatchObject({
      result: { snapshot: { status: 'cancelled' }, details: { recovery: [] } },
    });
    expect(terminal.eventTypes?.filter((type) => type === 'run.terminal')).toHaveLength(1);
    const calls = callMessages(first, recovered);
    expect(calls.map(({ kind }) => kind)).toStrictEqual(['cancel', 'reconcile']);
    const stableAttempt = rootAttempt(terminal.result);
    const reconciliation = calls.find(({ kind }) => kind === 'reconcile');
    expect(reconciliation).toMatchObject({
      executionId: stableAttempt.operationId,
      attemptId: stableAttempt.attemptId,
    });
    await withController(`revo-run-dispatch-won-inspection-${randomUUID()}`, async () => {
      const gate = DBOS.retrieveWorkflow(
        attemptDispatchArbitrationWorkflowId(stableAttempt.operationId, stableAttempt.attemptId),
      );
      await expect(gate.getResult()).resolves.toMatchObject({ winner: 'dispatch_won' });
    });
  }, 30_000);

  it('persists a sealed sibling terminal while its parallel peer remains recovery-required', async () => {
    const runId = `rn1-script-parallel-recovery-${randomUUID()}`;
    const applicationVersion = `rn1-script-dispatch-${randomUUID()}`;
    first = startWorker(runId, applicationVersion, 'start', [], 'parallel');

    const firstTerminal = await waitFor(first, 'terminal');
    expect(firstTerminal).toMatchObject({
      result: {
        snapshot: { status: 'recovery_required', terminal: null },
        details: { status: 'recovery_required' },
      },
    });
    expect(activityStatuses(firstTerminal)).toEqual(
      expect.arrayContaining(['recovery_required', 'succeeded']),
    );
    expect(firstTerminal.eventTypes?.filter((type) => type === 'run.terminal')).toHaveLength(0);

    recovered = startWorker(runId, applicationVersion, 'recover', [], 'parallel');
    const recoveredTerminal = await waitFor(recovered, 'terminal');
    expect(recoveredTerminal).toMatchObject({
      result: { snapshot: { status: 'recovery_required', terminal: null } },
    });
    expect(activityStatuses(recoveredTerminal)).toEqual(
      expect.arrayContaining(['recovery_required', 'succeeded']),
    );
    expect(callMessages(first, recovered).filter(({ kind }) => kind === 'execute')).toHaveLength(2);
  }, 30_000);
});
