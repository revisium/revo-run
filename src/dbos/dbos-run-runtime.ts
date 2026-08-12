import { randomBytes } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutor } from '../contracts/executor/run-executor.js';
import type { JsonValue } from '../contracts/json-value.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';
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
import type { WaitForTerminalInput } from '../contracts/run/wait-for-terminal.js';
import type { RunWorkflowInput } from '../contracts/workflow/run-workflow-input.js';
import { recoveryAdmissionError } from '../validation/execution-plan-recovery.js';
import { parseRunWorkflowInput } from '../validation/parse-run-workflow-data.js';
import { runWorkflowName } from './dbos-names.js';
import { loadRunDetails } from './read-model/load-run-details.js';
import { loadRunPage } from './read-model/load-run-page.js';
import { mapRunSnapshot, RunOwnershipError } from './read-model/map-run-snapshot.js';
import { loadRunEventPage, subscribeToRunEvents } from './read-model/run-event-reader.js';
import { waitForTerminalRun } from './read-model/wait-for-terminal-run.js';
import { runWorkflowId } from './workflow-id.js';
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
    const recoveryError = recoveryAdmissionError(
      executionPlan,
      this.executor.reconcile !== undefined,
    );
    if (recoveryError !== undefined) {
      throw new RunManagerError(recoveryError);
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
      return mapRunSnapshot(status, runWorkflowName, runId);
    } catch (error) {
      if (error instanceof RunOwnershipError) {
        return undefined;
      }
      throw new RunManagerError('run_read_failed');
    }
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
}
