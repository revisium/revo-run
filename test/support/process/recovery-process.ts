import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { testDatabaseUrl } from '../test-environment.js';

export interface RecoveryWorkerMessage {
  readonly kind:
    | 'checkpointed'
    | 'dispatched'
    | 'error'
    | 'events'
    | 'ready'
    | 'stopped'
    | 'terminal'
    | 'timeoutSignalled';
  readonly message?: string;
  readonly cursors?: readonly string[];
  readonly attemptOrdinal?: number;
  readonly path?: string;
  readonly status?: string;
  readonly types?: readonly string[];
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
  ) {
    const worker = fileURLToPath(new URL('./recovery-process-worker.ts', import.meta.url));
    this.child = fork(worker, {
      env: {
        ...process.env,
        REVO_RUN_TEST_DATABASE_URL: testDatabaseUrl(),
        REVO_RUN_TEST_MODE: mode,
        REVO_RUN_TEST_RUN_ID: runId,
        REVO_RUN_TEST_SCENARIO: scenario,
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

  complete(path: string): void {
    this.child.send({ kind: 'complete', path });
  }

  async waitFor(expected: Partial<RecoveryWorkerMessage>): Promise<void> {
    const deadline = Date.now() + 10_000;
    await this.pollFor(expected, deadline);
  }

  dispatched(path: string, attemptOrdinal?: number): number {
    return this.messages.filter(
      (message) =>
        message.kind === 'dispatched' &&
        message.path === path &&
        (attemptOrdinal === undefined || message.attemptOrdinal === attemptOrdinal),
    ).length;
  }

  eventStream(): { readonly cursors: readonly string[]; readonly types: readonly string[] } {
    const message = this.messages.findLast(({ kind }) => kind === 'events');
    if (message?.cursors === undefined || message.types === undefined) {
      throw new Error('Recovery worker did not report its event stream.');
    }
    return { cursors: message.cursors, types: message.types };
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
      (expected.path === undefined || message.path === expected.path) &&
      (expected.status === undefined || message.status === expected.status)
    );
  }

  private async pollFor(expected: Partial<RecoveryWorkerMessage>, deadline: number): Promise<void> {
    if (this.messages.some((message) => this.matches(message, expected))) {
      return;
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
    await this.pollFor(expected, deadline);
  }
}
