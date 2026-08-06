import type { RunSnapshot } from '../run/run.js';
import type { StartRunInput, StartRunResult } from '../run/start-run.js';
import { DbosRuntime } from '../runtime/dbos-runtime.js';

export class RunManager {
  private readonly runtime: DbosRuntime;
  private started = false;

  constructor(runtime: DbosRuntime) {
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.runtime.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.runtime.stop();
    this.started = false;
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    this.assertStarted();
    if (input.runId.length === 0) {
      throw new Error('Run ID must not be empty.');
    }
    await this.runtime.startRun(input.runId, input.executionPlan, input.input);
    return { runId: input.runId };
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    this.assertStarted();
    if (runId.length === 0) {
      throw new Error('Run ID must not be empty.');
    }
    return this.runtime.getRun(runId);
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('Run manager is not started.');
    }
  }
}
