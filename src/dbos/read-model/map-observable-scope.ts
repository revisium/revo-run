import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { RunScope } from '../../contracts/run/run-details.js';
import type { RunStatus } from '../../contracts/run/run.js';
import { parseMapItemResult } from '../../validation/map-item-result.validator.js';
import { parseParallelBranchResult } from '../../validation/parallel-branch-result.validator.js';
import { parseRunWorkflowResult } from '../../validation/parse-run-workflow-data.js';
import { parseRepeatIterationResult } from '../../validation/repeat-iteration-result.validator.js';
import { mapRunStatus } from './map-run-snapshot.js';
import type { DurableScopeCandidate } from './scope-candidate-from-status.js';

const epoch = (value: number | undefined, fallback?: number): number => {
  const resolved = value ?? fallback;
  if (resolved === undefined || !Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error('DBOS scope timestamp is invalid.');
  }
  return resolved;
};

const successfulScopeStatus = (
  status: WorkflowStatus,
  candidate: DurableScopeCandidate,
): RunStatus => {
  if (candidate.kind === 'root') {
    return parseRunWorkflowResult(status.output).status;
  }
  if (candidate.kind === 'repeatIteration') {
    const result = parseRepeatIterationResult(status.output);
    if (result.ordinal !== candidate.repeatIdentity.ordinal) {
      throw new Error('Repeat iteration workflow output identity is invalid.');
    }
    return result.kind === 'terminal' ? result.result.status : 'succeeded';
  }
  if (candidate.kind === 'mapItem') {
    const result = parseMapItemResult(status.output);
    if (
      result.sourceIndex !== candidate.mapIdentity.sourceIndex ||
      result.itemKey !== candidate.mapIdentity.itemKey
    ) {
      throw new Error('Map item workflow output identity is invalid.');
    }
    if (result.kind === 'terminal') {
      return result.result.status;
    }
    return result.kind === 'settlementOnly' ? 'cancelled' : 'succeeded';
  }
  const result = parseParallelBranchResult(status.output);
  if (result.key !== candidate.parallelIdentity.branchKey) {
    throw new Error('Parallel branch workflow output identity is invalid.');
  }
  return result.kind === 'terminal' ? result.result.status : 'succeeded';
};

const scopeDates = (status: WorkflowStatus, candidate: DurableScopeCandidate) => {
  const createdAt = epoch(status.createdAt);
  const updatedAt = epoch(status.updatedAt, createdAt);
  if (updatedAt < createdAt) {
    throw new Error('DBOS scope timestamps are inverted.');
  }
  const mappedStatus =
    status.status === 'SUCCESS'
      ? successfulScopeStatus(status, candidate)
      : mapRunStatus(status.status);
  const isTerminal = mappedStatus !== 'pending' && mappedStatus !== 'running';
  if (!isTerminal && status.completedAt !== undefined) {
    throw new Error('Non-terminal DBOS scope has a completion timestamp.');
  }
  if (status.completedAt === undefined) {
    return { status: mappedStatus, createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) };
  }
  const completedAt = epoch(status.completedAt);
  if (completedAt < createdAt || completedAt > updatedAt) {
    throw new Error('DBOS scope completion timestamp is inverted.');
  }
  return {
    status: mappedStatus,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    completedAt: new Date(completedAt),
  };
};

export const mapObservableScope = (
  status: WorkflowStatus,
  candidate: DurableScopeCandidate,
): Exclude<RunScope, { readonly kind: 'inlineSubpipeline' }> => {
  const dates = scopeDates(status, candidate);
  if (candidate.kind === 'root') {
    return {
      kind: 'root',
      id: candidate.id,
      pipelineId: candidate.pipelineId,
      displayPath: candidate.displayPath,
      ...dates,
    };
  }
  if (candidate.kind === 'repeatIteration') {
    return {
      kind: 'repeatIteration',
      id: candidate.id,
      parentScopeId: candidate.parentScopeId,
      pipelineId: candidate.pipelineId,
      displayPath: candidate.displayPath,
      ordinal: candidate.repeatIdentity.ordinal,
      ...dates,
    };
  }
  if (candidate.kind === 'mapItem') {
    return {
      kind: 'mapItem',
      id: candidate.id,
      parentScopeId: candidate.parentScopeId,
      pipelineId: candidate.pipelineId,
      displayPath: candidate.displayPath,
      mapNodeInstanceId: candidate.mapIdentity.mapNodeInstanceId,
      sourceIndex: candidate.mapIdentity.sourceIndex,
      itemKey: candidate.mapIdentity.itemKey,
      disposition: candidate.mapIdentity.disposition,
      ...dates,
    };
  }
  return {
    kind: 'parallelBranch',
    id: candidate.id,
    parentScopeId: candidate.parentScopeId,
    pipelineId: candidate.pipelineId,
    displayPath: candidate.displayPath,
    ...dates,
  };
};
