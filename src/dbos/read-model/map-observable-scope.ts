import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { Equal } from 'typebox/value';

import type { RunScope } from '../../contracts/run/run-details.js';
import type { RunStatus } from '../../contracts/run/run.js';
import { parseParallelBranchResult } from '../../validation/parallel-branch-result.validator.js';
import { parseParallelBranchWorkflowInput } from '../../validation/parallel-branch-workflow-input.validator.js';
import { parseRunWorkflowResult } from '../../validation/parse-run-workflow-data.js';
import { parseRepeatIterationResult } from '../../validation/repeat-iteration-result.validator.js';
import { parseRepeatIterationWorkflowInput } from '../../validation/repeat-iteration-workflow-input.validator.js';
import { parseRunExecutionWorkflowInput } from '../../validation/run-execution-workflow-input.validator.js';
import {
  parallelBranchWorkflowName,
  repeatIterationWorkflowName,
  runExecutionWorkflowName,
} from '../dbos-names.js';
import { scopeWorkflowId } from '../workflow-id.js';
import { mapRunStatus } from './map-run-snapshot.js';
import type { ObservableScopeCandidate } from './observable-plan.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

type ProviderScope =
  | {
      readonly kind: 'root';
      readonly scopeId: string;
    }
  | {
      readonly kind: 'parallelBranch';
      readonly scopeId: string;
      readonly input: ReturnType<typeof parseParallelBranchWorkflowInput>;
    }
  | {
      readonly kind: 'repeatIteration';
      readonly scopeId: string;
      readonly input: ReturnType<typeof parseRepeatIterationWorkflowInput>;
    };

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

const oneInput = (status: WorkflowStatus): unknown => {
  if (!Array.isArray(status.input) || status.input.length !== 1) {
    throw new Error('DBOS scope workflow input is invalid.');
  }
  return status.input[0];
};

const providerScopeFromStatus = (status: WorkflowStatus, runId: string): ProviderScope => {
  if (status.workflowName === runExecutionWorkflowName) {
    const input = parseRunExecutionWorkflowInput(oneInput(status));
    if (input.runId !== runId) {
      throw new Error('Root scope belongs to a different run.');
    }
    return { kind: 'root', scopeId: input.scopeId };
  }
  if (status.workflowName === parallelBranchWorkflowName) {
    const input = parseParallelBranchWorkflowInput(oneInput(status));
    if (input.runId !== runId) {
      throw new Error('Parallel scope belongs to a different run.');
    }
    return { kind: 'parallelBranch', scopeId: input.scopeId, input };
  }
  if (status.workflowName === repeatIterationWorkflowName) {
    const input = parseRepeatIterationWorkflowInput(oneInput(status));
    if (input.runId !== runId) {
      throw new Error('Repeat iteration scope belongs to a different run.');
    }
    return { kind: 'repeatIteration', scopeId: input.scopeId, input };
  }
  throw new Error('Run contains an unsupported child workflow.');
};

export const scopeCandidateFromStatus = (
  status: WorkflowStatus,
  runId: string,
  plan: import('./observable-plan.js').ObservablePlan,
): DurableScopeCandidate => {
  const providerScope = providerScopeFromStatus(status, runId);
  if (providerScope.kind === 'repeatIteration') {
    plan.addRepeatIteration(providerScope.input);
  }
  const candidate = plan.scopes.get(providerScope.scopeId);
  if (candidate === undefined || candidate.kind === 'inlineSubpipeline') {
    throw new Error('DBOS scope is not present in the admitted plan.');
  }
  const expectedWorkflowId = scopeWorkflowId(candidate.id);
  if (status.workflowID !== expectedWorkflowId) {
    throw new Error('DBOS scope workflow ID is invalid.');
  }
  if (status.parentWorkflowID !== candidate.parentWorkflowId) {
    throw new Error('DBOS scope workflow parent is invalid.');
  }

  if (providerScope.kind === 'root') {
    if (candidate.kind !== 'root') {
      throw new Error('DBOS scope workflow kind is invalid.');
    }
    return candidate;
  }

  if (providerScope.kind === 'repeatIteration') {
    if (candidate.kind !== 'repeatIteration') {
      throw new Error('DBOS scope workflow kind is invalid.');
    }
    const input = providerScope.input;
    if (
      input.parentScopeId !== candidate.parentScopeId ||
      input.ordinal !== candidate.repeatIdentity.ordinal ||
      input.pipelineId !== candidate.pipelineId ||
      input.runtimePath !== candidate.displayPath ||
      input.parentPath !== candidate.repeatIdentity.nodePath ||
      !Equal(input.node, candidate.repeatIdentity.node.body)
    ) {
      throw new Error('Repeat iteration scope durable identity is invalid.');
    }
    return candidate;
  }

  if (candidate.kind !== 'parallelBranch') {
    throw new Error('DBOS scope workflow kind is invalid.');
  }
  const expected = candidate.parallelIdentity;
  const input = providerScope.input;
  if (
    input.branchKey !== expected.branchKey ||
    !Equal(input.node, expected.node) ||
    input.pipelineId !== expected.pipelineId ||
    input.runtimePath !== expected.runtimePath ||
    input.parentPath !== expected.parentPath ||
    input.nodePathPrefix !== expected.nodePathPrefix
  ) {
    throw new Error('Parallel scope durable identity is invalid.');
  }
  return candidate;
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
  return {
    kind: 'parallelBranch',
    id: candidate.id,
    parentScopeId: candidate.parentScopeId,
    pipelineId: candidate.pipelineId,
    displayPath: candidate.displayPath,
    ...dates,
  };
};
