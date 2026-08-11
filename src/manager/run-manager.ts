import type { ListRunsInput, RunPage } from '../contracts/run/list-runs.js';
import type { RunDetails } from '../contracts/run/run-details.js';
import type {
  RunEventPage,
  RunEventPageInput,
  RunEventSubscriptionInput,
} from '../contracts/run/run-event-page.js';
import type { RunEvent } from '../contracts/run/run-event.js';
import { RunManagerError } from '../contracts/run/run-manager-error.js';
import type { RunSnapshot } from '../contracts/run/run.js';
import type { StartRunInput, StartRunResult } from '../contracts/run/start-run.js';
import type { WaitForTerminalInput } from '../contracts/run/wait-for-terminal.js';
import type { DbosRunRuntime } from '../dbos/dbos-run-runtime.js';
import { isListRunsInput } from '../validation/list-runs.validator.js';
import {
  isRunEventCursor,
  isRunEventPageInput,
  isRunEventSubscriptionInput,
  runEventCursorRunId,
} from '../validation/run-event-page.validator.js';
import { isValidRunId } from '../validation/run-id.validator.js';
import { validateStartRunInput } from '../validation/start-run.validator.js';
import { isWaitForTerminalInput } from '../validation/wait-for-terminal.validator.js';
import { managedRunEventSubscription } from './run-event-subscription.js';

type RunRuntime = Pick<
  DbosRunRuntime,
  | 'getRun'
  | 'getRunDetails'
  | 'getRunEvents'
  | 'listRuns'
  | 'start'
  | 'startRun'
  | 'stop'
  | 'subscribeRunEvents'
  | 'waitForTerminal'
>;

export class RunManager {
  private readonly runtime: RunRuntime;
  private started = false;
  private startOperation: Promise<void> | undefined;
  private stopOperation: Promise<void> | undefined;
  private lifecycle = new AbortController();

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

  async listRuns(input: ListRunsInput = {}): Promise<RunPage> {
    this.assertStarted();
    if (!isListRunsInput(input)) {
      throw new RunManagerError('invalid_list_runs_input');
    }
    try {
      return await this.runtime.listRuns(input);
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

  async getRunEvents(runId: string, input: RunEventPageInput = {}): Promise<RunEventPage> {
    this.assertRunId(runId);
    this.assertEventPageInput(input);
    try {
      return await this.runtime.getRunEvents(runId, input);
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_read_failed');
    }
  }

  subscribeRunEvents(
    runId: string,
    input: RunEventSubscriptionInput = {},
  ): AsyncIterable<RunEvent> {
    this.assertRunId(runId);
    this.assertSubscriptionInput(input);
    if (input.after !== undefined && runEventCursorRunId(input.after) !== runId) {
      throw new RunManagerError('invalid_run_event_cursor');
    }
    return managedRunEventSubscription(
      this.runtime.subscribeRunEvents(runId, input),
      this.lifecycle.signal,
    );
  }

  async waitForTerminal(runId: string, input: WaitForTerminalInput = {}): Promise<RunSnapshot> {
    this.assertRunId(runId);
    if (!isWaitForTerminalInput(input)) {
      throw new RunManagerError('invalid_wait_for_terminal_input');
    }
    if (this.lifecycle.signal.aborted) {
      throw new RunManagerError('manager_not_started');
    }
    if (input.signal?.aborted === true) {
      throw new RunManagerError('run_wait_aborted');
    }
    try {
      return await this.runtime.waitForTerminal(runId, input, this.lifecycle.signal);
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_read_failed');
    }
  }

  private async startRuntime(): Promise<void> {
    await this.runtime.start();
    this.lifecycle = new AbortController();
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

    this.lifecycle.abort();
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

  private assertEventPageInput(input: unknown): asserts input is RunEventPageInput {
    if (
      typeof input === 'object' &&
      input !== null &&
      'after' in input &&
      input.after !== undefined &&
      !isRunEventCursor(input.after)
    ) {
      throw new RunManagerError('invalid_run_event_cursor');
    }
    if (!isRunEventPageInput(input)) {
      throw new RunManagerError('invalid_run_event_page_input');
    }
  }

  private assertSubscriptionInput(input: unknown): asserts input is RunEventSubscriptionInput {
    if (
      typeof input === 'object' &&
      input !== null &&
      'after' in input &&
      input.after !== undefined &&
      !isRunEventCursor(input.after)
    ) {
      throw new RunManagerError('invalid_run_event_cursor');
    }
    if (!isRunEventSubscriptionInput(input)) {
      throw new RunManagerError('invalid_run_event_cursor');
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
