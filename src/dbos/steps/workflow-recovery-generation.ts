import { DBOS } from '@dbos-inc/dbos-sdk';

import { parseDbosWorkflowStatus } from '../../validation/dbos-workflow-status.validator.js';
import { consensusParticipantWorkflowName } from '../consensus/consensus-names.js';
import {
  parallelBranchWorkflowName,
  mapItemWorkflowName,
  repeatIterationWorkflowName,
  runExecutionWorkflowName,
} from '../dbos-names.js';

const supportedWorkflowNames = new Set([
  runExecutionWorkflowName,
  parallelBranchWorkflowName,
  mapItemWorkflowName,
  repeatIterationWorkflowName,
  consensusParticipantWorkflowName,
]);

export const currentRecoveryGeneration = async (): Promise<number> => {
  const workflowId = DBOS.workflowID;
  if (workflowId === undefined) {
    throw new Error('Node effect has no DBOS workflow identity.');
  }
  const unvalidatedStatus = await DBOS.getWorkflowStatus(workflowId);
  if (unvalidatedStatus === null) {
    throw new Error('Node effect recovery generation is invalid.');
  }
  const status = parseDbosWorkflowStatus(unvalidatedStatus);
  const generation = status.recoveryAttempts;
  if (
    status?.workflowID !== workflowId ||
    !supportedWorkflowNames.has(status.workflowName) ||
    generation === undefined ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    throw new Error('Node effect recovery generation is invalid.');
  }
  return generation;
};
