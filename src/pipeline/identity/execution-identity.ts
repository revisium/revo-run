import { createHash } from 'node:crypto';

import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';

type IdentityComponent = number | string;
type IdentityPrefix = 'an1' | 'at1' | 'ni1' | 'sc1';

const identity = (
  prefix: IdentityPrefix,
  domain: string,
  components: readonly IdentityComponent[],
): string => {
  for (const component of components) {
    if (typeof component === 'number' && (!Number.isSafeInteger(component) || component < 0)) {
      throw new RangeError('Identity ordinals must be non-negative safe integers.');
    }
  }

  const preimage = JSON.stringify(['revo-run.identity', 1, domain, ...components]);
  const digest = createHash('sha256').update(preimage, 'utf8').digest('base64url');
  return `${prefix}_${digest}`;
};

export const createAuthoredNodeId = (input: {
  readonly schemaVersion: number;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly nodeKind: PipelineNode['kind'];
}): string =>
  identity('an1', 'authored-node', [
    input.schemaVersion,
    input.pipelineId,
    input.nodePath,
    input.nodeKind,
  ]);

export const createRootScopeId = (input: {
  readonly runId: string;
  readonly rootPipelineId: string;
}): string => identity('sc1', 'scope', ['root', input.runId, input.rootPipelineId]);

export const createSubpipelineScopeId = (input: {
  readonly parentScopeId: string;
  readonly authoredNodeId: string;
  readonly invocationOrdinal: number;
}): string => {
  if (input.invocationOrdinal < 1) {
    throw new RangeError('Subpipeline invocation ordinal must be positive.');
  }
  return identity('sc1', 'scope', [
    'subpipeline',
    input.parentScopeId,
    input.authoredNodeId,
    input.invocationOrdinal,
  ]);
};

export const createParallelBranchScopeId = (input: {
  readonly parentScopeId: string;
  readonly authoredNodeId: string;
  readonly branchKey: string;
}): string =>
  identity('sc1', 'scope', [
    'parallel',
    input.parentScopeId,
    input.authoredNodeId,
    input.branchKey,
  ]);

export const createMapItemScopeId = (input: {
  readonly parentScopeId: string;
  readonly authoredNodeId: string;
  readonly itemKey: string;
}): string =>
  identity('sc1', 'scope', ['map', input.parentScopeId, input.authoredNodeId, input.itemKey]);

export const createConsensusParticipantScopeId = (input: {
  readonly parentScopeId: string;
  readonly authoredNodeId: string;
  readonly participantId: string;
}): string =>
  identity('sc1', 'scope', [
    'consensus',
    input.parentScopeId,
    input.authoredNodeId,
    input.participantId,
  ]);

export const createRepeatIterationScopeId = (input: {
  readonly parentScopeId: string;
  readonly authoredNodeId: string;
  readonly iterationOrdinal: number;
}): string => {
  if (input.iterationOrdinal < 1) {
    throw new RangeError('Repeat iteration ordinal must be positive.');
  }
  return identity('sc1', 'scope', [
    'repeat',
    input.parentScopeId,
    input.authoredNodeId,
    input.iterationOrdinal,
  ]);
};

export const createNodeInstanceId = (input: {
  readonly scopeId: string;
  readonly authoredNodeId: string;
}): string => identity('ni1', 'node-instance', [input.scopeId, input.authoredNodeId]);

export const createAttemptId = (input: {
  readonly nodeInstanceId: string;
  readonly attemptOrdinal: number;
}): string => {
  if (input.attemptOrdinal < 1) {
    throw new RangeError('Attempt ordinal must be positive.');
  }
  return identity('at1', 'attempt', [input.nodeInstanceId, input.attemptOrdinal]);
};
