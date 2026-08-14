import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { JsonValue, NodeOutput, RunCommandReceipt } from '../../../src/index.js';
import { testDatabaseUrl } from '../test-environment.js';
import type { RecoveryInstruction } from './effect-recovery-scenario-program.js';

interface ReportedAttempt {
  readonly ordinal: number;
  readonly output?: NodeOutput;
  readonly recovery?: { readonly reconciliationRound: number };
  readonly status: string;
}

interface ReportedEvent {
  readonly data: unknown;
  readonly type: string;
}

interface ReportedDetails {
  readonly attempts: readonly ReportedAttempt[];
  readonly commands: readonly {
    readonly actorId?: string;
    readonly commandKind: string;
    readonly decision: string;
    readonly resolution?: { readonly kind: string; readonly outcome?: string };
    readonly targetAttemptId?: string;
  }[];
  readonly nodeStatuses: readonly { readonly path: string; readonly status: string }[];
  readonly runOutput?: NodeOutput;
  readonly workflowName?: string;
}

export interface RecoveryProcessOptions {
  readonly holdReconciliation?: boolean;
  readonly ignoreAbort?: boolean;
  readonly input?: JsonValue;
  readonly instructions?: readonly RecoveryInstruction[];
  readonly pauseBeforeIntent?: boolean;
  readonly pauseBeforeAdmission?: boolean | number;
  readonly pauseAfterDecision?: boolean;
  readonly pauseBeforeReadiness?: boolean | number;
  readonly failCommandEventBudget?: boolean;
}

export interface RecoveryWorkerMessage {
  readonly kind:
    | 'beforeIntent'
    | 'beforeAdmission'
    | 'beforeReadiness'
    | 'afterDecision'
    | 'attemptObserved'
    | 'checkpointed'
    | 'details'
    | 'dispatched'
    | 'error'
    | 'events'
    | 'executorAborted'
    | 'parallelObserved'
    | 'ready'
    | 'reconciled'
    | 'commandReceipt'
    | 'scopeCancellationAcknowledged'
    | 'stopped'
    | 'terminal'
    | 'timeoutSignalled';
  readonly message?: string;
  readonly attempts?: readonly ReportedAttempt[];
  readonly cursors?: readonly string[];
  readonly events?: readonly ReportedEvent[];
  readonly attemptOrdinal?: number;
  readonly attemptId?: string;
  readonly path?: string;
  readonly nodeInstanceId?: string;
  readonly status?: string;
  readonly types?: readonly string[];
  readonly commandReceipt?: RunCommandReceipt;
  readonly commands?: ReportedDetails['commands'];
  readonly nodeStatuses?: ReportedDetails['nodeStatuses'];
  readonly runOutput?: NodeOutput;
  readonly workflowName?: string;
  readonly observedBranchKeys?: readonly string[];
  readonly skippedBranchKeys?: readonly string[];
  readonly remaining?: string;
}

export class RecoveryProcess {
  private readonly child;
  private readonly messages: RecoveryWorkerMessage[] = [];
  private readonly errors: string[] = [];
  private childError: Error | undefined;

  constructor(
    mode: 'recover' | 'start',
    runId: string,
    scenario = 'sequence',
    retryDelayMs?: number,
    options: RecoveryProcessOptions = {},
  ) {
    const worker = fileURLToPath(new URL('./recovery-process-worker.ts', import.meta.url));
    this.child = fork(worker, {
      env: {
        ...process.env,
        REVO_RUN_TEST_DATABASE_URL: testDatabaseUrl(),
        REVO_RUN_TEST_MODE: mode,
        REVO_RUN_TEST_RUN_ID: runId,
        REVO_RUN_TEST_SCENARIO: scenario,
        ...(options.input === undefined
          ? {}
          : { REVO_RUN_TEST_INPUT: JSON.stringify(options.input) }),
        ...(options.instructions === undefined
          ? {}
          : { REVO_RUN_TEST_RECONCILIATIONS: JSON.stringify(options.instructions) }),
        ...(options.pauseBeforeIntent === true
          ? { REVO_RUN_TEST_PAUSE_BEFORE_INTENT: 'true' }
          : {}),
        ...(options.pauseBeforeAdmission === undefined || options.pauseBeforeAdmission === false
          ? {}
          : {
              REVO_RUN_TEST_PAUSE_BEFORE_ADMISSION: String(
                options.pauseBeforeAdmission === true ? 1 : options.pauseBeforeAdmission,
              ),
            }),
        ...(options.pauseAfterDecision === true
          ? { REVO_RUN_TEST_PAUSE_AFTER_DECISION: 'true' }
          : {}),
        ...(options.pauseBeforeReadiness === undefined || options.pauseBeforeReadiness === false
          ? {}
          : {
              REVO_RUN_TEST_PAUSE_BEFORE_READINESS: String(
                options.pauseBeforeReadiness === true ? 1 : options.pauseBeforeReadiness,
              ),
            }),
        ...(options.failCommandEventBudget === true
          ? { REVO_RUN_TEST_FAIL_COMMAND_EVENT_BUDGET: 'true' }
          : {}),
        ...(options.holdReconciliation === true
          ? { REVO_RUN_TEST_HOLD_RECONCILIATION: 'true' }
          : {}),
        ...(options.ignoreAbort === true ? { REVO_RUN_TEST_IGNORE_ABORT: 'true' } : {}),
        ...(retryDelayMs === undefined
          ? {}
          : { REVO_RUN_TEST_RETRY_DELAY_MS: String(retryDelayMs) }),
      },
      execArgv: ['--import', 'tsx'],
      silent: true,
    });
    this.child.on('message', (message: RecoveryWorkerMessage) => this.messages.push(message));
    this.child.on('error', (error) => {
      this.childError = error;
    });
    this.child.stderr?.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()));
  }

  complete(
    path: string,
    result: { readonly outcome: string; readonly output?: NodeOutput } = { outcome: 'completed' },
  ): void {
    this.child.send({
      kind: 'complete',
      path,
      result: {
        outcome: result.outcome,
        ...(result.output === undefined ? {} : { output: result.output }),
      },
    });
  }

  resolveUnknownOutcome(
    attemptId: string,
    actorId: string,
    resolution:
      | {
          readonly kind: 'adoptSuccess';
          readonly outcome: string;
          readonly output?: NodeOutput;
        }
      | { readonly kind: 'markFailed' }
      | { readonly kind: 'retry' },
  ): void {
    this.child.send({ kind: 'resolveUnknownOutcome', attemptId, actorId, resolution });
  }

  cancel(actorId: string): void {
    this.child.send({ kind: 'cancelRun', actorId });
  }

  releaseReadiness(): void {
    this.child.send({ kind: 'releaseReadiness' });
  }

  releaseAdmission(): void {
    this.child.send({ kind: 'releaseAdmission' });
  }

  releaseDecision(): void {
    this.child.send({ kind: 'releaseDecision' });
  }

  async waitForCount(kind: RecoveryWorkerMessage['kind'], count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    await this.pollForCount(kind, count, deadline);
  }

  private async pollForCount(
    kind: RecoveryWorkerMessage['kind'],
    count: number,
    deadline: number,
  ): Promise<void> {
    if (this.messages.filter((message) => message.kind === kind).length >= count) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Recovery worker did not emit ${count} ${kind} messages.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await this.pollForCount(kind, count, deadline);
  }

  commandReceipts(): readonly RunCommandReceipt[] {
    return this.messages.flatMap(({ commandReceipt }) =>
      commandReceipt === undefined ? [] : [commandReceipt],
    );
  }

  async waitFor(expected: Partial<RecoveryWorkerMessage>): Promise<RecoveryWorkerMessage> {
    const deadline = Date.now() + 10_000;
    return this.pollFor(expected, deadline);
  }

  dispatched(path: string, attemptOrdinal?: number): number {
    return this.messages.filter(
      (message) =>
        message.kind === 'dispatched' &&
        message.path === path &&
        (attemptOrdinal === undefined || message.attemptOrdinal === attemptOrdinal),
    ).length;
  }

  count(kind: RecoveryWorkerMessage['kind'], path?: string): number {
    return this.messages.filter(
      (message) => message.kind === kind && (path === undefined || message.path === path),
    ).length;
  }

  eventStream(): { readonly cursors: readonly string[]; readonly types: readonly string[] } {
    const message = this.messages.findLast(({ kind }) => kind === 'events');
    if (message?.cursors === undefined || message.types === undefined) {
      throw new Error('Recovery worker did not report its event stream.');
    }
    return { cursors: message.cursors, types: message.types };
  }

  reportedAttempts(): readonly ReportedAttempt[] {
    const message = this.messages.findLast(({ kind }) => kind === 'details');
    if (message?.attempts === undefined) {
      throw new Error('Recovery worker did not report run attempts.');
    }
    return message.attempts;
  }

  reportedDetails(): ReportedDetails {
    const message = this.messages.findLast(({ kind }) => kind === 'details');
    if (
      message?.attempts === undefined ||
      message.commands === undefined ||
      message.nodeStatuses === undefined
    ) {
      throw new Error('Recovery worker did not report run details.');
    }
    return {
      attempts: message.attempts,
      commands: message.commands,
      nodeStatuses: message.nodeStatuses,
      ...(message.runOutput === undefined ? {} : { runOutput: message.runOutput }),
      ...(message.workflowName === undefined ? {} : { workflowName: message.workflowName }),
    };
  }

  reportedEvents(): readonly ReportedEvent[] {
    const message = this.messages.findLast(({ kind }) => kind === 'events');
    if (message?.events === undefined) {
      throw new Error('Recovery worker did not report run events.');
    }
    return message.events;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.child.kill('SIGKILL');
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
  }

  private matches(
    message: RecoveryWorkerMessage,
    expected: Partial<RecoveryWorkerMessage>,
  ): boolean {
    return (
      (expected.kind === undefined || message.kind === expected.kind) &&
      (expected.message === undefined || message.message === expected.message) &&
      (expected.attemptOrdinal === undefined ||
        message.attemptOrdinal === expected.attemptOrdinal) &&
      (expected.attemptId === undefined || message.attemptId === expected.attemptId) &&
      (expected.path === undefined || message.path === expected.path) &&
      (expected.status === undefined || message.status === expected.status)
    );
  }

  private async pollFor(
    expected: Partial<RecoveryWorkerMessage>,
    deadline: number,
  ): Promise<RecoveryWorkerMessage> {
    const message = this.messages.find((candidate) => this.matches(candidate, expected));
    if (message !== undefined) {
      return message;
    }
    if (
      Date.now() >= deadline ||
      this.childError !== undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) {
      throw new Error(
        `Recovery worker did not emit ${JSON.stringify(expected)}. ` +
          `exitCode=${String(this.child.exitCode)} signalCode=${String(this.child.signalCode)} ` +
          `childError=${this.childError?.message ?? 'none'}. ` +
          `Messages: ${JSON.stringify(this.messages)}. stderr: ${this.errors.join('')}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    return this.pollFor(expected, deadline);
  }
}
