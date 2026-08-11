import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { testDatabaseUrl } from '../support/test-environment.js';

interface WorkerMessage {
  readonly kind:
    | 'checkpointed'
    | 'dispatched'
    | 'error'
    | 'events'
    | 'stopped'
    | 'terminal'
    | 'timeoutSignalled';
  readonly message?: string;
  readonly cursors?: readonly string[];
  readonly path?: string;
  readonly status?: string;
  readonly types?: readonly string[];
}

class RecoveryProcess {
  private readonly child;
  private readonly messages: WorkerMessage[] = [];
  private readonly errors: string[] = [];

  constructor(mode: 'recover' | 'start', runId: string, scenario = 'sequence') {
    const worker = fileURLToPath(
      new URL('../support/process/recovery-process-worker.ts', import.meta.url),
    );
    this.child = fork(worker, {
      env: {
        ...process.env,
        REVO_RUN_TEST_DATABASE_URL: testDatabaseUrl(),
        REVO_RUN_TEST_MODE: mode,
        REVO_RUN_TEST_RUN_ID: runId,
        REVO_RUN_TEST_SCENARIO: scenario,
      },
      execArgv: ['--import', 'tsx'],
      silent: true,
    });
    this.child.on('message', (message: WorkerMessage) => this.messages.push(message));
    this.child.stderr?.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()));
  }

  complete(path: string): void {
    this.child.send({ kind: 'complete', path });
  }

  async waitFor(expected: Partial<WorkerMessage>): Promise<void> {
    const deadline = Date.now() + 10_000;
    await this.pollFor(expected, deadline);
  }

  dispatched(path: string): number {
    return this.messages.filter((message) => message.kind === 'dispatched' && message.path === path)
      .length;
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

  private matches(message: WorkerMessage, expected: Partial<WorkerMessage>): boolean {
    return (
      (expected.kind === undefined || message.kind === expected.kind) &&
      (expected.message === undefined || message.message === expected.message) &&
      (expected.path === undefined || message.path === expected.path) &&
      (expected.status === undefined || message.status === expected.status)
    );
  }

  private async pollFor(expected: Partial<WorkerMessage>, deadline: number): Promise<void> {
    if (this.messages.some((message) => this.matches(message, expected))) {
      return;
    }
    if (Date.now() >= deadline || this.child.exitCode !== null) {
      throw new Error(
        `Recovery worker did not emit ${JSON.stringify(expected)}. Messages: ${JSON.stringify(this.messages)}. ${this.errors.join('')}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    await this.pollFor(expected, deadline);
  }
}

describe('process recovery', () => {
  it('does not dispatch a checkpointed task after a process crash', async () => {
    const runId = `process-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId);
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/first' });
      firstProcess.complete('main/first');
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/second' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId);
      await recoveredProcess.waitFor({ kind: 'dispatched', path: 'main/second' });
      expect(recoveredProcess.dispatched('main/first')).toBe(0);

      recoveredProcess.complete('main/second');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'events' });
      const events = recoveredProcess.eventStream();
      expect(events.types).toStrictEqual([
        'nodeExecution.started',
        'nodeExecution.completed',
        'nodeExecution.started',
        'nodeExecution.completed',
        'run.completed',
      ]);
      expect(events.cursors).toStrictEqual(
        events.cursors.map((_, index) => `${runId}:${index + 1}`),
      );
      expect(new Set(events.cursors).size).toBe(events.cursors.length);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);

  it('routes a checkpointed timeout identically after a process crash', async () => {
    const runId = `timeout-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'timeout');
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'timeoutSignalled', path: 'main/work' });
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/after-timeout' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'timeout');
      await recoveredProcess.waitFor({ kind: 'dispatched', path: 'main/after-timeout' });
      expect(recoveredProcess.dispatched('main/work')).toBe(0);

      recoveredProcess.complete('main/after-timeout');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);

  it('recovers parallel branches without repeating a checkpointed effect', async () => {
    const runId = `parallel-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'parallel');
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/a' });
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/b' });
      firstProcess.complete('main/work/a');
      await firstProcess.waitFor({ kind: 'checkpointed', path: 'main/work/a' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'parallel');
      await recoveredProcess.waitFor({ kind: 'dispatched', path: 'main/work/b' });
      expect(recoveredProcess.dispatched('main/work/a')).toBe(0);

      recoveredProcess.complete('main/work/b');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);
});
