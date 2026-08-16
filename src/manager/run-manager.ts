import type { ListRunsInput, RunPage } from '../contracts/run/list-runs.js';
import type {
  AnswerGateInput,
  CancelRunInput,
  ResolveUnknownOutcomeInput,
  RunCommandReceipt,
} from '../contracts/run/run-command.js';
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
import { RunCommandDispatcher } from './run-command-dispatcher.js';
import { managedRunEventSubscription } from './run-event-subscription.js';
import { RunManagerLifecycle } from './run-manager-lifecycle.js';

type RunRuntime = Pick<
  DbosRunRuntime,
  | 'cancelRun'
  | 'getRun'
  | 'getRunDetails'
  | 'getRunEvents'
  | 'listRuns'
  | 'start'
  | 'startRun'
  | 'stop'
  | 'subscribeRunEvents'
  | 'resolveUnknownOutcome'
  | 'answerGate'
  | 'waitForTerminal'
>;

export class RunManager {
  private readonly runtime: RunRuntime;
  private readonly commands: RunCommandDispatcher;
  private readonly lifecycle: RunManagerLifecycle;

  constructor(runtime: RunRuntime) {
    this.runtime = runtime;
    this.commands = new RunCommandDispatcher(runtime);
    this.lifecycle = new RunManagerLifecycle(runtime);
  }

  async start(): Promise<void> {
    return this.lifecycle.start();
  }

  async stop(): Promise<void> {
    return this.lifecycle.stop();
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
      await this.lifecycle.track(() =>
        this.runtime.startRun(input.runId, input.executionPlan, input.input),
      );
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_admission_failed');
    }
    return { runId: input.runId };
  }

  async cancelRun(input: CancelRunInput): Promise<RunCommandReceipt> {
    this.assertStarted();
    return this.lifecycle.track(() => this.commands.cancel(input));
  }

  async resolveUnknownOutcome(input: ResolveUnknownOutcomeInput): Promise<RunCommandReceipt> {
    this.assertStarted();
    return this.lifecycle.track(() => this.commands.resolveUnknownOutcome(input));
  }

  async answerGate(input: AnswerGateInput): Promise<RunCommandReceipt> {
    this.assertStarted();
    return this.lifecycle.track(() => this.commands.answerGate(input));
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    this.assertRunId(runId);
    try {
      return await this.lifecycle.track(() => this.runtime.getRun(runId));
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
      return await this.lifecycle.track(() => this.runtime.listRuns(input));
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
      return await this.lifecycle.track(() => this.runtime.getRunDetails(runId));
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
      return await this.lifecycle.track(() => this.runtime.getRunEvents(runId, input));
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
      () => this.lifecycle.trackSubscription(),
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
      return await this.lifecycle.track(() =>
        this.runtime.waitForTerminal(runId, input, this.lifecycle.signal),
      );
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_read_failed');
    }
  }

  private assertStarted(): void {
    this.lifecycle.assertRunning();
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
}
