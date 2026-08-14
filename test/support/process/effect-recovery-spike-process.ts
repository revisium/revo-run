import { fileURLToPath } from 'node:url';

import { testDatabaseUrl } from '../test-environment.js';
import type {
  EffectRecoverySpikeMessage,
  EffectRecoverySpikePhase,
  EffectRecoverySpikeScenario,
  EffectRecoverySpikeScope,
} from './effect-recovery-spike-protocol.js';
import { forkTestDbosProcess } from './fork-test-dbos-process.js';
import { testProcessApplicationVersion } from './test-process-application-version.js';

export interface EffectRecoverySpikeProcessInput {
  readonly attemptId: string;
  readonly phase: EffectRecoverySpikePhase;
  readonly scenario: EffectRecoverySpikeScenario;
  readonly scope: EffectRecoverySpikeScope;
  readonly semanticWorkflowId: string;
  readonly workflowId: string;
}

export class EffectRecoverySpikeProcess {
  private readonly child;
  private readonly messages: EffectRecoverySpikeMessage[] = [];
  private readonly errors: string[] = [];
  private childError: Error | undefined;

  constructor(input: EffectRecoverySpikeProcessInput) {
    const worker = fileURLToPath(new URL('./effect-recovery-spike-worker.ts', import.meta.url));
    this.child = forkTestDbosProcess(worker, {
      applicationVersion: testProcessApplicationVersion(
        'effect-recovery-spike',
        input.semanticWorkflowId,
      ),
      env: {
        REVO_RUN_RR06_SPIKE_ATTEMPT_ID: input.attemptId,
        REVO_RUN_RR06_SPIKE_DATABASE_URL: testDatabaseUrl(),
        REVO_RUN_RR06_SPIKE_PHASE: input.phase,
        REVO_RUN_RR06_SPIKE_SCENARIO: input.scenario,
        REVO_RUN_RR06_SPIKE_SCOPE: input.scope,
        REVO_RUN_RR06_SPIKE_SEMANTIC_WORKFLOW_ID: input.semanticWorkflowId,
        REVO_RUN_RR06_SPIKE_WORKFLOW_ID: input.workflowId,
      },
    });
    this.child.on('message', (message: EffectRecoverySpikeMessage) => {
      this.messages.push(message);
    });
    this.child.on('error', (error) => {
      this.childError = error;
    });
    this.child.stderr?.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()));
  }

  count(kind: EffectRecoverySpikeMessage['kind']): number {
    return this.messages.filter((message) => message.kind === kind).length;
  }

  resolveWait(): void {
    this.child.send({ kind: 'resolveWait' });
  }

  async waitFor(
    expected: Partial<EffectRecoverySpikeMessage>,
  ): Promise<EffectRecoverySpikeMessage> {
    return this.pollFor(expected, Date.now() + 15_000);
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.child.kill('SIGKILL');
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
  }

  private matches(
    message: EffectRecoverySpikeMessage,
    expected: Partial<EffectRecoverySpikeMessage>,
  ): boolean {
    return (
      (expected.activeReconciliations === undefined ||
        message.activeReconciliations === expected.activeReconciliations) &&
      (expected.attemptOrdinal === undefined ||
        message.attemptOrdinal === expected.attemptOrdinal) &&
      (expected.kind === undefined || message.kind === expected.kind) &&
      (expected.liveGeneration === undefined ||
        message.liveGeneration === expected.liveGeneration) &&
      (expected.message === undefined || message.message === expected.message) &&
      (expected.status === undefined || message.status === expected.status) &&
      (expected.storedGeneration === undefined ||
        message.storedGeneration === expected.storedGeneration)
    );
  }

  private async pollFor(
    expected: Partial<EffectRecoverySpikeMessage>,
    deadline: number,
  ): Promise<EffectRecoverySpikeMessage> {
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
        `RR-06 spike worker did not emit ${JSON.stringify(expected)}. ` +
          `exitCode=${String(this.child.exitCode)} signalCode=${String(this.child.signalCode)} ` +
          `childError=${this.childError?.message ?? 'none'}. ` +
          `Messages: ${JSON.stringify(this.messages)}. stderr: ${this.errors.join('')}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    return this.pollFor(expected, deadline);
  }
}
