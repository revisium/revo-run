import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { RunScenario } from '../../dsl/scenario.js';
import { testDatabaseUrl } from '../test-environment.js';
import { forkTestDbosProcess } from './fork-test-dbos-process.js';
import { testProcessApplicationVersion } from './test-process-application-version.js';

interface WorkerMessage {
  readonly kind: 'error' | 'gatePending' | 'stopped' | 'succeeded';
  readonly message?: string;
}

class HumanGateRecoveryProcess {
  private readonly child;
  private readonly messages: WorkerMessage[] = [];
  private readonly errors: string[] = [];

  constructor(phase: 'wait' | 'answer', runId: string) {
    const worker = fileURLToPath(new URL('./run-human-gate-recovery-worker.ts', import.meta.url));
    this.child = forkTestDbosProcess(worker, {
      applicationVersion: testProcessApplicationVersion('human-gate', runId),
      env: {
        REVO_RUN_TEST_DATABASE_URL: testDatabaseUrl(),
        REVO_RUN_TEST_RUN_ID: runId,
        REVO_RUN_TEST_PHASE: phase,
      },
    });
    this.child.on('message', (message: WorkerMessage) => this.messages.push(message));
    this.child.stderr?.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()));
  }

  async expect(kind: WorkerMessage['kind']): Promise<void> {
    const deadline = Date.now() + 20_000;
    const poll = async (): Promise<void> => {
      const found = this.messages.find((message) => message.kind === kind);
      if (found !== undefined) {
        return;
      }
      const failed = this.messages.find((message) => message.kind === 'error');
      if (failed !== undefined) {
        throw new Error(failed.message ?? 'Human-gate recovery worker reported an error.');
      }
      if (Date.now() >= deadline || this.child.exitCode !== null) {
        throw new Error(
          `Did not observe ${kind}. Messages: ${JSON.stringify(this.messages)}. ${this.errors.join('')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      return poll();
    };
    return poll();
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.child.kill('SIGKILL');
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
  }
}

export const runHumanGateRecoveryScenario = async (scenario: RunScenario): Promise<void> => {
  if (scenario.intentId !== 'rr-043') {
    throw new Error('Human-gate recovery harness received an unsupported scenario.');
  }
  const runId = `rr043-${randomUUID()}`;
  const first = new HumanGateRecoveryProcess('wait', runId);
  let recovered: HumanGateRecoveryProcess | undefined;
  try {
    await first.expect('gatePending');
    await first.kill();
    recovered = new HumanGateRecoveryProcess('answer', runId);
    await recovered.expect('succeeded');
    await recovered.expect('stopped');
  } finally {
    await first.kill();
    await recovered?.kill();
  }
};
