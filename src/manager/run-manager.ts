import type { RunDetails } from '../contracts/run/run-details.js';
import type { RunEvent } from '../contracts/run/run-event.js';
import { RunManagerError } from '../contracts/run/run-manager-error.js';
import type { RunSnapshot } from '../contracts/run/run.js';
import type { StartRunInput, StartRunResult } from '../contracts/run/start-run.js';
import type { DbosRunRuntime } from '../dbos/dbos-run-runtime.js';
import { isValidRunId } from '../validation/run-id.validator.js';
import { validateStartRunInput } from '../validation/start-run.validator.js';

type RunRuntime = Pick<
  DbosRunRuntime,
  'getRun' | 'getRunDetails' | 'start' | 'startRun' | 'stop' | 'subscribeRunEvents'
>;

export class RunManager {
  private readonly runtime: RunRuntime;
  private started = false;
  private startOperation: Promise<void> | undefined;
  private stopOperation: Promise<void> | undefined;

  constructor(runtime: RunRuntime) {
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    if (this.stopOperation !== undefined) {
      await this.waitForStop(this.stopOperation);
    }
    if (this.started) {
      return;
    }
    if (this.startOperation !== undefined) {
      return this.waitForStart(this.startOperation);
    }

    const operation = this.startRuntime();
    this.startOperation = operation;
    try {
      await this.waitForStart(operation);
    } finally {
      if (this.startOperation === operation) {
        this.startOperation = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopOperation !== undefined) {
      return this.waitForStop(this.stopOperation);
    }

    const operation = this.stopRuntime();
    this.stopOperation = operation;
    try {
      await this.waitForStop(operation);
    } finally {
      if (this.stopOperation === operation) {
        this.stopOperation = undefined;
      }
    }
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    this.assertStarted();
    let validationError;
    try {
      validationError = validateStartRunInput(input);
    } catch {
      throw new RunManagerError('invalid_start_run_input');
    }
    if (validationError !== undefined) {
      throw new RunManagerError(validationError);
    }
    try {
      await this.runtime.startRun(input.runId, input.executionPlan, input.input);
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_admission_failed');
    }
    return { runId: input.runId };
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    this.assertRunId(runId);
    try {
      return await this.runtime.getRun(runId);
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_read_failed');
    }
  }

  async getRunDetails(runId: string): Promise<RunDetails | undefined> {
    this.assertRunId(runId);
    try {
      return await this.runtime.getRunDetails(runId);
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_read_failed');
    }
  }

  subscribeRunEvents(runId: string): AsyncIterable<RunEvent> {
    this.assertRunId(runId);
    return this.readRunEvents(runId);
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
      throw new RunManagerError('manager_not_started');
    }
  }

  private assertRunId(runId: unknown): asserts runId is string {
    this.assertStarted();
    if (!isValidRunId(runId)) {
      throw new RunManagerError('invalid_run_id');
    }
  }

  private async *readRunEvents(runId: string): AsyncGenerator<RunEvent> {
    try {
      for await (const event of this.runtime.subscribeRunEvents(runId)) {
        yield event;
      }
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_event_subscription_failed');
    }
  }

  private async waitForStart(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch {
      throw new RunManagerError('manager_start_failed');
    }
  }

  private async waitForStop(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch {
      throw new RunManagerError('manager_stop_failed');
    }
  }
}
