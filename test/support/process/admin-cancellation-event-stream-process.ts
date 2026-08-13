import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { RunEvent, RunEventPage, RunSnapshot } from '../../../src/index.js';
import { testDatabaseUrl } from '../test-environment.js';

export interface AdminCancellationEventStreamReport {
  readonly acceptedPrefix: readonly RunEvent[];
  readonly childStatus: string;
  readonly eventPage: RunEventPage;
  readonly noExternalEffect: boolean;
  readonly run: RunSnapshot;
}

type WorkerMessage =
  | { readonly kind: 'error'; readonly message: string }
  | ({ readonly kind: 'report' } & AdminCancellationEventStreamReport);

export class AdminCancellationEventStreamProcess {
  private readonly child;
  private readonly messages: WorkerMessage[] = [];
  private readonly errors: string[] = [];
  private childError: Error | undefined;

  constructor(runId: string) {
    const worker = fileURLToPath(
      new URL('./admin-cancellation-event-stream-worker.ts', import.meta.url),
    );
    this.child = fork(worker, {
      env: {
        ...process.env,
        REVO_RUN_TEST_DATABASE_URL: testDatabaseUrl(),
        REVO_RUN_TEST_RUN_ID: runId,
      },
      execArgv: ['--import', 'tsx'],
      silent: true,
    });
    this.child.on('message', (message: WorkerMessage) => this.messages.push(message));
    this.child.on('error', (error) => {
      this.childError = error;
    });
    this.child.stderr?.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()));
  }

  async report(): Promise<AdminCancellationEventStreamReport> {
    return this.pollForReport(Date.now() + 10_000);
  }

  private async pollForReport(deadline: number): Promise<AdminCancellationEventStreamReport> {
    const message = this.messages[0];
    if (message?.kind === 'report') {
      return message;
    }
    if (message?.kind === 'error') {
      throw new Error(`Administrative cancellation worker reported: ${message.message}`);
    }
    if (this.childError !== undefined) {
      throw new Error(`Administrative cancellation worker errored: ${this.childError.message}`);
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error(
        `Administrative cancellation worker exited before reporting. ` +
          `exitCode=${String(this.child.exitCode)} signalCode=${String(this.child.signalCode)}. ` +
          `stderr: ${this.errors.join('')}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Administrative cancellation worker did not report before its deadline. ` +
          `stderr: ${this.errors.join('')}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    return this.pollForReport(deadline);
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const childPid = this.child.pid;
    if (childPid === undefined || !Number.isSafeInteger(childPid) || childPid <= 0) {
      throw new Error('Administrative cancellation worker has no valid spawned child PID.');
    }
    if (!this.child.kill('SIGKILL')) {
      throw new Error(`Administrative cancellation worker ${childPid} could not be terminated.`);
    }
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
  }
}
