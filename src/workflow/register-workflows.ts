import { DBOS } from '@dbos-inc/dbos-sdk';
import type { JsonValue } from '@revisium/revo-pipeline';

import {
  interpretExecutionPlan,
  RUN_TERMINAL_ENVELOPE,
  RunInterpretationError,
  type RunTerminalEnvelope,
} from '../pipeline/interpret-pipeline.js';
import type { ExecutionPlan } from '../types.js';
import { getWorkflowDependencies } from './workflow-context.js';

export const RUN_WORKFLOW_NAME = 'revo-run.run.v2';

const runWorkflow = async (
  executionPlan: ExecutionPlan,
  input: JsonValue,
): Promise<RunTerminalEnvelope> => {
  const runId = DBOS.workflowID;
  if (runId === undefined) {
    throw new Error('Run workflow has no DBOS workflow ID.');
  }
  try {
    return await interpretExecutionPlan(
      runId,
      executionPlan,
      input,
      getWorkflowDependencies().executor,
    );
  } catch (error: unknown) {
    if (error instanceof RunInterpretationError) {
      return {
        error:
          error.code === 'execution_failed'
            ? { code: error.code, message: error.message }
            : { code: error.code },
        kind: RUN_TERMINAL_ENVELOPE,
        status: 'failed',
      };
    }
    throw error;
  }
};

export interface RegisteredWorkflows {
  readonly run: (executionPlan: ExecutionPlan, input: JsonValue) => Promise<RunTerminalEnvelope>;
}

let registeredWorkflows: RegisteredWorkflows | undefined;

export const registerWorkflows = (): RegisteredWorkflows => {
  if (registeredWorkflows) {
    return registeredWorkflows;
  }
  const run = DBOS.registerWorkflow(runWorkflow, { name: RUN_WORKFLOW_NAME });
  registeredWorkflows = { run };
  return registeredWorkflows;
};
