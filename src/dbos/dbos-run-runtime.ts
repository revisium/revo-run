import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutor } from '../contracts/executor/run-executor.js';
import type { JsonValue } from '../contracts/json-value.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';
import type { ListRunsInput, RunPage } from '../contracts/run/list-runs.js';
import type {
  AnswerGateInput,
  CancelRunInput,
  CommandId,
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
import type { WaitForTerminalInput } from '../contracts/run/wait-for-terminal.js';
import type {
  CommandDispatchWorkflowInput,
  DurableRunCommand,
} from '../contracts/workflow/run-command-workflow.js';
import type { RunWorkflowInput } from '../contracts/workflow/run-workflow-input.js';
import { executionPlanAdmissionError } from '../validation/execution-plan-admission.js';
import { parseRunWorkflowInput } from '../validation/parse-run-workflow-data.js';
import {
  parseCommandDispatchInput,
  parseCommandDispatchResult,
} from '../validation/run-command-workflow.validator.js';
import { runWorkflowName } from './dbos-names.js';
import { loadRunDetails } from './read-model/load-run-details.js';
import { loadRunPage } from './read-model/load-run-page.js';
import { mapRunSnapshot, RunOwnershipError } from './read-model/map-run-snapshot.js';
import { loadRunEventPage, subscribeToRunEvents } from './read-model/run-event-reader.js';
import { waitForTerminalRun } from './read-model/wait-for-terminal-run.js';
import { commandWorkflowId, runWorkflowId } from './workflow-id.js';
import type { WorkflowRegistry } from './workflow-registry.js';

const applicationName = 'revo-run';

export class DbosRunRuntime {
  private readonly databaseUrl: string;
  private readonly executor: RunExecutor;
  private readonly workflows: WorkflowRegistry;
  private releaseExecutor: (() => void) | undefined;

  constructor(databaseUrl: string, executor: RunExecutor, workflows: WorkflowRegistry) {
    this.databaseUrl = databaseUrl;
    this.executor = executor;
    this.workflows = workflows;
  }

  async start(): Promise<void> {
    this.releaseExecutor = this.workflows.bindExecutor(this.executor);
    try {
      DBOS.setConfig({
        name: applicationName,
        systemDatabaseUrl: this.databaseUrl,
      });
      await DBOS.launch();
    } catch (error) {
      this.releaseExecutor();
      this.releaseExecutor = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await DBOS.shutdown();
    this.releaseExecutor?.();
    this.releaseExecutor = undefined;
  }

  async startRun(runId: string, executionPlan: ExecutionPlan, input: JsonValue): Promise<void> {
    const admissionError = executionPlanAdmissionError(
      executionPlan,
      this.executor.reconcile !== undefined,
    );
    if (admissionError !== undefined) {
      throw new RunManagerError(admissionError);
    }

    const workflowId = runWorkflowId(runId);
    let status;
    try {
      status = await DBOS.getWorkflowStatus(workflowId);
    } catch {
      throw new RunManagerError('run_admission_failed');
    }
    if (status !== null) {
      throw new RunManagerError('run_id_conflict');
    }

    const admissionToken = randomBytes(32).toString('base64url');
    const durableInput: RunWorkflowInput = {
      runId,
      admissionToken,
      executionPlan,
      input,
    };
    try {
      await DBOS.startWorkflow(this.workflows.run, {
        workflowID: workflowId,
      })(durableInput);
    } catch {
      // A transport failure can happen after DBOS commits the workflow. Ownership is confirmed below.
    }

    await this.confirmAdmission(workflowId, runId, admissionToken);
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    const workflowId = runWorkflowId(runId);
    let status;
    try {
      status = await DBOS.getWorkflowStatus(workflowId);
    } catch {
      throw new RunManagerError('run_read_failed');
    }
    if (status === null) {
      return undefined;
    }

    try {
      if (status.workflowName !== runWorkflowName) {
        return undefined;
      }
      return mapRunSnapshot(status, runWorkflowName, runId);
    } catch (error) {
      if (error instanceof RunOwnershipError) {
        return undefined;
      }
      throw new RunManagerError('run_read_failed');
    }
  }

  async cancelRun(input: CancelRunInput): Promise<RunCommandReceipt> {
    await this.assertRunExistsBeforeCommandId(input.runId);
    return this.dispatchCommand({ kind: 'cancelRun', input }, `cmd_${randomUUID()}`);
  }

  async resolveUnknownOutcome(input: ResolveUnknownOutcomeInput): Promise<RunCommandReceipt> {
    await this.assertRunExistsBeforeCommandId(input.runId);
    return this.dispatchCommand({ kind: 'resolveUnknownOutcome', input }, `cmd_${randomUUID()}`);
  }

  async answerGate(input: AnswerGateInput): Promise<RunCommandReceipt> {
    await this.assertRunExistsBeforeCommandId(input.runId);
    const { commandId, ...commandInput } = input;
    return this.dispatchCommand({ kind: 'answerGate', input: commandInput }, commandId);
  }

  /**
   * Internal replay seam. cancelRun and resolveUnknownOutcome always receive a manager-generated
   * UUID; answerGate is the one command whose commandId is caller-supplied (ADR: caller-supplied
   * commandId + ni1_ addressing), so its idempotency depends on the stored-input equality check
   * in dispatchDurableCommand below rather than on this method minting the id.
   */
  async dispatchCommand(
    command: DurableRunCommand,
    commandId: CommandId,
  ): Promise<RunCommandReceipt> {
    return this.dispatchDurableCommand(command, commandId);
  }

  async listRuns(input: ListRunsInput): Promise<RunPage> {
    try {
      return await loadRunPage(input);
    } catch {
      throw new RunManagerError('run_read_failed');
    }
  }

  async getRunDetails(runId: string): Promise<RunDetails | undefined> {
    const run = await this.getRun(runId);
    if (run === undefined) {
      return undefined;
    }

    try {
      return await loadRunDetails(run);
    } catch {
      throw new RunManagerError('run_read_failed');
    }
  }

  async getRunEvents(runId: string, input: RunEventPageInput): Promise<RunEventPage> {
    if ((await this.getRun(runId)) === undefined) {
      throw new RunManagerError('run_not_found');
    }
    try {
      return await loadRunEventPage(runId, input);
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_read_failed');
    }
  }

  async *subscribeRunEvents(
    runId: string,
    input: RunEventSubscriptionInput,
  ): AsyncGenerator<RunEvent> {
    const run = await this.getRun(runId);
    if (run === undefined) {
      throw new RunManagerError('run_not_found');
    }

    yield* subscribeToRunEvents(runId, input);
  }

  async waitForTerminal(
    runId: string,
    input: WaitForTerminalInput,
    managerSignal: AbortSignal,
  ): Promise<RunSnapshot> {
    return waitForTerminalRun(() => this.getRun(runId), input, managerSignal);
  }

  private async confirmAdmission(
    workflowId: string,
    runId: string,
    admissionToken: string,
  ): Promise<void> {
    let status;
    try {
      status = await DBOS.getWorkflowStatus(workflowId);
    } catch {
      throw new RunManagerError('run_admission_failed');
    }
    if (status === null) {
      throw new RunManagerError('run_admission_failed');
    }
    if (status.workflowName !== runWorkflowName) {
      throw new RunManagerError('run_id_conflict');
    }

    let durableArguments;
    try {
      durableArguments = await DBOS.retrieveWorkflow(workflowId).getWorkflowInputs<unknown[]>();
    } catch {
      throw new RunManagerError('run_admission_failed');
    }

    let durableInput;
    try {
      durableInput = parseRunWorkflowInput(durableArguments);
    } catch {
      throw new RunManagerError('run_id_conflict');
    }
    if (durableInput.runId !== runId || durableInput.admissionToken !== admissionToken) {
      throw new RunManagerError('run_id_conflict');
    }
  }

  private async dispatchDurableCommand(
    command: DurableRunCommand,
    commandId: CommandId,
  ): Promise<RunCommandReceipt> {
    const durableInput: CommandDispatchWorkflowInput = { commandId, command };
    try {
      const workflowId = commandWorkflowId(commandId);
      const handle = await DBOS.startWorkflow(this.workflows.commandDispatch, {
        workflowID: workflowId,
      })(durableInput);
      const storedArguments =
        await DBOS.retrieveWorkflow(workflowId).getWorkflowInputs<unknown[]>();
      const storedInput = parseCommandDispatchInput(storedArguments[0]);
      if (!isDeepStrictEqual(storedInput, durableInput)) {
        throw new RunManagerError('run_command_failed', commandId);
      }
      const result = parseCommandDispatchResult(await handle.getResult());
      switch (result.status) {
        case 'receipt':
          return result.receipt;
        case 'runNotFound':
          throw new RunManagerError('run_not_found');
        case 'dispatchFailed':
          throw new RunManagerError('run_command_failed', commandId);
      }
      result satisfies never;
      throw new RunManagerError('run_command_failed', commandId);
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_command_failed', commandId);
    }
  }

  private async assertRunExistsBeforeCommandId(runId: string): Promise<void> {
    try {
      if ((await DBOS.getWorkflowStatus(runWorkflowId(runId))) === null) {
        throw new RunManagerError('run_not_found');
      }
    } catch (error) {
      if (error instanceof RunManagerError) {
        throw error;
      }
      throw new RunManagerError('run_command_failed');
    }
  }
}
