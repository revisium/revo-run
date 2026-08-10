import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunWorkflowInput } from '../../contracts/workflow/run-workflow-input.js';
import { parseRunWorkflowInput } from '../../validation/parse-run-workflow-data.js';
import { runWorkflowId } from '../workflow-id.js';

export const loadRunWorkflowInput = async (runId: string): Promise<RunWorkflowInput> => {
  const workflowArguments = await DBOS.retrieveWorkflow(runWorkflowId(runId)).getWorkflowInputs<
    unknown[]
  >();
  return parseRunWorkflowInput(workflowArguments);
};
