import { DBOS } from '@dbos-inc/dbos-sdk';

import {
  parseDbosStepRecord,
  type DbosStepRecord,
} from '../../validation/dbos-step-record.validator.js';

const pageSize = 100;

export type { DbosStepRecord } from '../../validation/dbos-step-record.validator.js';

export const countWorkflowStepsByName = async (
  workflowId: string,
  name: string,
): Promise<number> => {
  const loadPage = async (
    offset: number,
    previousFunctionId: number | undefined,
    count: number,
  ): Promise<number> => {
    const page = await DBOS.listWorkflowSteps(workflowId, { limit: pageSize, offset });
    if (page === undefined) {
      throw new Error('DBOS workflow steps were not found.');
    }
    let lastFunctionId = previousFunctionId;
    let nextCount = count;
    for (const value of page) {
      const step = parseDbosStepRecord(value);
      if (lastFunctionId !== undefined && step.functionID <= lastFunctionId) {
        throw new Error('DBOS workflow steps are not strictly ordered.');
      }
      lastFunctionId = step.functionID;
      if (step.name === name) {
        nextCount += 1;
      }
    }
    return page.length === pageSize
      ? loadPage(offset + page.length, lastFunctionId, nextCount)
      : nextCount;
  };

  return loadPage(0, undefined, 0);
};

export const loadAllWorkflowSteps = async (
  workflowId: string,
): Promise<readonly DbosStepRecord[]> => {
  const steps: DbosStepRecord[] = [];
  const loadPage = async (offset: number): Promise<void> => {
    const page = await DBOS.listWorkflowSteps(workflowId, { limit: pageSize, offset });
    if (page === undefined) {
      throw new Error('DBOS workflow steps were not found.');
    }
    const parsed = page.map(parseDbosStepRecord);
    steps.push(...parsed);
    if (page.length === pageSize) {
      await loadPage(offset + page.length);
    }
  };

  await loadPage(0);

  const ordered = [...steps].sort((left, right) => left.functionID - right.functionID);
  if (new Set(ordered.map(({ functionID }) => functionID)).size !== ordered.length) {
    throw new Error('DBOS workflow steps contain duplicate function IDs.');
  }
  return ordered;
};
