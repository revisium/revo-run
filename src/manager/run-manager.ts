import type { RunDetails } from '../contracts/run/run-details.js';
import type { RunEvent } from '../contracts/run/run-event.js';
import type { RunSnapshot } from '../contracts/run/run.js';
import type { StartRunInput, StartRunResult } from '../contracts/run/start-run.js';
import { DbosRunRuntime } from '../dbos/dbos-run-runtime.js';
import { validateStartRunInput } from '../validation/start-run.validator.js';

export class RunManager {
  private readonly runtime: DbosRunRuntime;
  private started = false;
  private startOperation: Promise<void> | undefined;
  private stopOperation: Promise<void> | undefined;

  constructor(runtime: DbosRunRuntime) {
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    if (this.stopOperation !== undefined) {
      await this.stopOperation;
    }
    if (this.started) {
      return;
    }
    if (this.startOperation !== undefined) {
      return this.startOperation;
    }

    const operation = this.startRuntime();
    this.startOperation = operation;
    try {
      await operation;
    } finally {
      if (this.startOperation === operation) {
        this.startOperation = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopOperation !== undefined) {
      return this.stopOperation;
    }

    const operation = this.stopRuntime();
    this.stopOperation = operation;
    try {
      await operation;
    } finally {
      if (this.stopOperation === operation) {
        this.stopOperation = undefined;
      }
    }
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    this.assertStarted();
    validateStartRunInput(input);
    await this.runtime.startRun(input.runId, input.executionPlan, input.input);
    return { runId: input.runId };
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    this.assertRunId(runId);
    return this.runtime.getRun(runId);
  }

  async getRunDetails(runId: string): Promise<RunDetails | undefined> {
    this.assertRunId(runId);
    return this.runtime.getRunDetails(runId);
  }

  subscribeRunEvents(runId: string): AsyncIterable<RunEvent> {
    this.assertRunId(runId);
    return this.runtime.subscribeRunEvents(runId);
  }

  private async startRuntime(): Promise<void> {
    await this.runtime.start();
    this.started = true;
  }

  private async stopRuntime(): Promise<void> {
    if (this.startOperation !== undefined) {
      try {
        await this.startOperation;
      } catch {
        return;
      }
    }
    if (!this.started) {
      return;
    }

    await this.runtime.stop();
    this.started = false;
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('Run manager is not started.');
    }
  }

  private assertRunId(runId: string): void {
    this.assertStarted();
    if (runId.length === 0) {
      throw new Error('Run ID must not be empty.');
    }
  }
}
