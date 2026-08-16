import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { Equal } from 'typebox/value';

import { parseConsensusParticipantWorkflowInput } from '../../validation/consensus-participant-workflow-input.validator.js';
import { parseMapItemWorkflowInput } from '../../validation/map-item-workflow-input.validator.js';
import { parseParallelBranchWorkflowInput } from '../../validation/parallel-branch-workflow-input.validator.js';
import { parseRepeatIterationWorkflowInput } from '../../validation/repeat-iteration-workflow-input.validator.js';
import { parseRunExecutionWorkflowInput } from '../../validation/run-execution-workflow-input.validator.js';
import { consensusParticipantWorkflowName } from '../consensus/consensus-names.js';
import {
  mapItemWorkflowName,
  parallelBranchWorkflowName,
  repeatIterationWorkflowName,
  runExecutionWorkflowName,
} from '../dbos-names.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { ObservablePlan, ObservableScopeCandidate } from './observable-plan.js';

export type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

type ProviderScope =
  | { readonly kind: 'root'; readonly scopeId: string }
  | {
      readonly kind: 'parallelBranch';
      readonly scopeId: string;
      readonly input: ReturnType<typeof parseParallelBranchWorkflowInput>;
    }
  | {
      readonly kind: 'repeatIteration';
      readonly scopeId: string;
      readonly input: ReturnType<typeof parseRepeatIterationWorkflowInput>;
    }
  | {
      readonly kind: 'mapItem';
      readonly scopeId: string;
      readonly input: ReturnType<typeof parseMapItemWorkflowInput>;
    }
  | {
      readonly kind: 'consensusParticipant';
      readonly scopeId: string;
      readonly input: ReturnType<typeof parseConsensusParticipantWorkflowInput>;
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
  if (status.workflowName === mapItemWorkflowName) {
    const input = parseMapItemWorkflowInput(oneInput(status));
    if (input.runId !== runId) {
      throw new Error('Map item scope belongs to a different run.');
    }
    return { kind: 'mapItem', scopeId: input.scopeId, input };
  }
  if (status.workflowName === consensusParticipantWorkflowName) {
    const input = parseConsensusParticipantWorkflowInput(oneInput(status));
    if (input.runId !== runId) {
      throw new Error('Consensus participant scope belongs to a different run.');
    }
    return { kind: 'consensusParticipant', scopeId: input.scopeId, input };
  }
  throw new Error('Run contains an unsupported child workflow.');
};

const materializeDynamicScope = (providerScope: ProviderScope, plan: ObservablePlan): void => {
  if (providerScope.kind === 'repeatIteration') {
    plan.addRepeatIteration(providerScope.input);
  }
  if (providerScope.kind === 'mapItem') {
    plan.addMapItem(providerScope.input);
  }
};

const durableCandidate = (
  providerScope: ProviderScope,
  plan: ObservablePlan,
): DurableScopeCandidate => {
  const candidate = plan.scopes.get(providerScope.scopeId);
  if (candidate === undefined || candidate.kind === 'inlineSubpipeline') {
    throw new Error('DBOS scope is not present in the admitted plan.');
  }
  return candidate;
};

const assertWorkflowLocation = (status: WorkflowStatus, candidate: DurableScopeCandidate): void => {
  if (status.workflowID !== scopeWorkflowId(candidate.id)) {
    throw new Error('DBOS scope workflow ID is invalid.');
  }
  if (status.parentWorkflowID !== candidate.parentWorkflowId) {
    throw new Error('DBOS scope workflow parent is invalid.');
  }
};

const rootCandidate = (
  candidate: DurableScopeCandidate,
): Extract<DurableScopeCandidate, { readonly kind: 'root' }> => {
  if (candidate.kind !== 'root') {
    throw new Error('DBOS scope workflow kind is invalid.');
  }
  return candidate;
};

const repeatCandidate = (
  providerScope: Extract<ProviderScope, { readonly kind: 'repeatIteration' }>,
  candidate: DurableScopeCandidate,
): Extract<DurableScopeCandidate, { readonly kind: 'repeatIteration' }> => {
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
};

const mapCandidate = (
  providerScope: Extract<ProviderScope, { readonly kind: 'mapItem' }>,
  candidate: DurableScopeCandidate,
): Extract<DurableScopeCandidate, { readonly kind: 'mapItem' }> => {
  if (candidate.kind !== 'mapItem') {
    throw new Error('DBOS scope workflow kind is invalid.');
  }
  const input = providerScope.input;
  const expected = candidate.mapIdentity;
  if (
    input.parentScopeId !== candidate.parentScopeId ||
    input.mapNodeInstanceId !== expected.mapNodeInstanceId ||
    input.sourceIndex !== expected.sourceIndex ||
    input.itemKey !== expected.itemKey ||
    input.disposition !== expected.disposition ||
    input.pipelineId !== candidate.pipelineId ||
    input.runtimePath !== candidate.displayPath ||
    input.parentPath !== expected.nodePath ||
    !Equal(input.node, expected.node.body)
  ) {
    throw new Error('Map item scope durable identity is invalid.');
  }
  return candidate;
};

const consensusCandidate = (
  providerScope: Extract<ProviderScope, { readonly kind: 'consensusParticipant' }>,
  candidate: DurableScopeCandidate,
): Extract<DurableScopeCandidate, { readonly kind: 'consensusParticipant' }> => {
  if (candidate.kind !== 'consensusParticipant') {
    throw new Error('DBOS scope workflow kind is invalid.');
  }
  const expected = candidate.consensusIdentity;
  const input = providerScope.input;
  if (
    input.parentScopeId !== candidate.parentScopeId ||
    input.participantId !== expected.participantId ||
    input.consensusNodeInstanceId !== expected.consensusNodeInstanceId ||
    input.pipelineId !== expected.pipelineId ||
    input.runtimePath !== expected.runtimePath ||
    input.parentPath !== expected.parentPath ||
    input.nodePathPrefix !== expected.nodePathPrefix ||
    !Equal(input.node, expected.node)
  ) {
    throw new Error('Consensus participant scope durable identity is invalid.');
  }
  return candidate;
};

const parallelCandidate = (
  providerScope: Extract<ProviderScope, { readonly kind: 'parallelBranch' }>,
  candidate: DurableScopeCandidate,
): Extract<DurableScopeCandidate, { readonly kind: 'parallelBranch' }> => {
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

export const scopeCandidateFromStatus = (
  status: WorkflowStatus,
  runId: string,
  plan: ObservablePlan,
): DurableScopeCandidate => {
  const providerScope = providerScopeFromStatus(status, runId);
  materializeDynamicScope(providerScope, plan);
  const candidate = durableCandidate(providerScope, plan);
  assertWorkflowLocation(status, candidate);

  switch (providerScope.kind) {
    case 'root':
      return rootCandidate(candidate);
    case 'parallelBranch':
      return parallelCandidate(providerScope, candidate);
    case 'repeatIteration':
      return repeatCandidate(providerScope, candidate);
    case 'mapItem':
      return mapCandidate(providerScope, candidate);
    case 'consensusParticipant':
      return consensusCandidate(providerScope, candidate);
  }
  providerScope satisfies never;
  throw new Error('DBOS provider scope kind is unsupported.');
};
