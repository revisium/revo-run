import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createAttemptId,
  createAuthoredNodeId,
  createNodeInstanceId,
  createParallelBranchScopeId,
  createRootScopeId,
  createRepeatIterationScopeId,
  createSubpipelineScopeId,
} from '../../src/pipeline/identity/execution-identity.js';

const authored = (pipelineId: string, nodePath: string) =>
  createAuthoredNodeId({ schemaVersion: 1, pipelineId, nodePath, nodeKind: 'task' });

const vectors = {
  authored: {
    preimage: '["revo-run.identity",1,"authored-node",1,"main","review/work","task"]',
    id: 'an1_BYW2nwnO40jf9tlycsumXEFTVf1yerdx2XBtWVTTvFs',
  },
  rootScope: {
    preimage: '["revo-run.identity",1,"scope","root","run-1","main"]',
    id: 'sc1_clyAHiqG7zXhGZlQ_uqwcxlRnjsi3MFsunfd1fMXqPw',
  },
  subpipelineScope: {
    preimage: '["revo-run.identity",1,"scope","subpipeline","parent-scope","authored-node",2]',
    id: 'sc1_aX6tRaTqdWvNAuFn2cgRi8HSGuEjkmuEOqyF_pjDqbs',
  },
  parallelScope: {
    preimage:
      '["revo-run.identity",1,"scope","parallel","parent-scope","authored-node","branch-a"]',
    id: 'sc1_ovAf-0GdDCQFGQm2f4XR8C-t0vT5mJ4swiaiv5fKdMA',
  },
  repeatScope: {
    preimage: '["revo-run.identity",1,"scope","repeat","parent-scope","authored-node",2]',
    id: 'sc1_7lf1DyAFdOMaidkSlzdGYKML1NPk0ynXVyvGKcTPz4I',
  },
  nodeInstance: {
    preimage: '["revo-run.identity",1,"node-instance","scope-id","authored-node"]',
    id: 'ni1_3FGgaRTlFS8Sb9MlqMT42VXOulT8I26qEr_aOdnqm7Q',
  },
  attempt: {
    preimage: '["revo-run.identity",1,"attempt","node-instance",2]',
    id: 'at1_6K24stfhNzbFfkCmzDyYoIHYotC5cTWeXCg1gzoNI4g',
  },
} as const;

describe('execution identity', () => {
  it('is stable across replay and opaque at every identity layer', () => {
    const authoredNodeId = authored('main', 'review/work');
    const scopeId = createRootScopeId({ runId: 'run-1', rootPipelineId: 'main' });
    const nodeInstanceId = createNodeInstanceId({ scopeId, authoredNodeId });
    const attemptId = createAttemptId({ nodeInstanceId, attemptOrdinal: 1 });

    expect(authored('main', 'review/work')).toBe(authoredNodeId);
    expect(createRootScopeId({ runId: 'run-1', rootPipelineId: 'main' })).toBe(scopeId);
    expect(createNodeInstanceId({ scopeId, authoredNodeId })).toBe(nodeInstanceId);
    expect(createAttemptId({ nodeInstanceId, attemptOrdinal: 1 })).toBe(attemptId);
    expect(authoredNodeId).toMatch(/^an1_[A-Za-z0-9_-]{43}$/);
    expect(scopeId).toMatch(/^sc1_[A-Za-z0-9_-]{43}$/);
    expect(nodeInstanceId).toMatch(/^ni1_[A-Za-z0-9_-]{43}$/);
    expect(attemptId).toMatch(/^at1_[A-Za-z0-9_-]{43}$/);
    expect(attemptId).not.toContain('review/work');
  });

  it('pins the versioned wire tuple and digest for every identity kind', () => {
    for (const { preimage, id } of Object.values(vectors)) {
      expect(createHash('sha256').update(preimage, 'utf8').digest('base64url')).toBe(id.slice(4));
    }

    expect(authored('main', 'review/work')).toBe(vectors.authored.id);
    expect(createRootScopeId({ runId: 'run-1', rootPipelineId: 'main' })).toBe(
      vectors.rootScope.id,
    );
    expect(
      createSubpipelineScopeId({
        parentScopeId: 'parent-scope',
        authoredNodeId: 'authored-node',
        invocationOrdinal: 2,
      }),
    ).toBe(vectors.subpipelineScope.id);
    expect(
      createParallelBranchScopeId({
        parentScopeId: 'parent-scope',
        authoredNodeId: 'authored-node',
        branchKey: 'branch-a',
      }),
    ).toBe(vectors.parallelScope.id);
    expect(
      createRepeatIterationScopeId({
        parentScopeId: 'parent-scope',
        authoredNodeId: 'authored-node',
        iterationOrdinal: 2,
      }),
    ).toBe(vectors.repeatScope.id);
    expect(createNodeInstanceId({ scopeId: 'scope-id', authoredNodeId: 'authored-node' })).toBe(
      vectors.nodeInstance.id,
    );
    expect(createAttemptId({ nodeInstanceId: 'node-instance', attemptOrdinal: 2 })).toBe(
      vectors.attempt.id,
    );
  });

  it('separates the shared scope protocol by explicit scope kind', () => {
    expect(
      new Set([
        vectors.rootScope.id,
        vectors.subpipelineScope.id,
        vectors.parallelScope.id,
        vectors.repeatScope.id,
      ]).size,
    ).toBe(4);
    expect(vectors.rootScope.preimage).toContain('"scope","root"');
    expect(vectors.subpipelineScope.preimage).toContain('"scope","subpipeline"');
    expect(vectors.parallelScope.preimage).toContain('"scope","parallel"');
    expect(vectors.repeatScope.preimage).toContain('"scope","repeat"');
  });

  it('frames tuple components instead of joining them with delimiters', () => {
    expect(authored('a-b', 'c')).not.toBe(authored('a', 'b-c'));
  });

  it('does not collapse distinct unpaired UTF-16 surrogates in run IDs', () => {
    expect(
      createRootScopeId({ runId: String.fromCharCode(0xd800), rootPipelineId: 'main' }),
    ).not.toBe(createRootScopeId({ runId: String.fromCharCode(0xd801), rootPipelineId: 'main' }));
  });

  it('separates nested scopes, parallel branches, node instances, and real attempts', () => {
    const root = createRootScopeId({ runId: 'run-1', rootPipelineId: 'main' });
    const call = authored('main', 'call-child');
    const nestedOne = createSubpipelineScopeId({
      parentScopeId: root,
      authoredNodeId: call,
      invocationOrdinal: 1,
    });
    const nestedTwo = createSubpipelineScopeId({
      parentScopeId: root,
      authoredNodeId: call,
      invocationOrdinal: 2,
    });
    const branchA = createParallelBranchScopeId({
      parentScopeId: root,
      authoredNodeId: authored('main', 'checks'),
      branchKey: 'a',
    });
    const branchB = createParallelBranchScopeId({
      parentScopeId: root,
      authoredNodeId: authored('main', 'checks'),
      branchKey: 'b',
    });
    const repeatOne = createRepeatIterationScopeId({
      parentScopeId: root,
      authoredNodeId: authored('main', 'review'),
      iterationOrdinal: 1,
    });
    const repeatTwo = createRepeatIterationScopeId({
      parentScopeId: root,
      authoredNodeId: authored('main', 'review'),
      iterationOrdinal: 2,
    });
    const nestedRepeat = createRepeatIterationScopeId({
      parentScopeId: repeatOne,
      authoredNodeId: authored('main', 'review/nested'),
      iterationOrdinal: 1,
    });
    const node = createNodeInstanceId({
      scopeId: nestedOne,
      authoredNodeId: authored('child', 'work'),
    });

    expect(nestedOne).not.toBe(nestedTwo);
    expect(branchA).not.toBe(branchB);
    expect(repeatOne).not.toBe(repeatTwo);
    expect(nestedRepeat).not.toBe(repeatOne);
    expect(createAttemptId({ nodeInstanceId: node, attemptOrdinal: 1 })).not.toBe(
      createAttemptId({ nodeInstanceId: node, attemptOrdinal: 2 }),
    );
    expect(() => createAttemptId({ nodeInstanceId: node, attemptOrdinal: 0 })).toThrow(
      'Attempt ordinal must be positive.',
    );
    expect(() =>
      createAttemptId({ nodeInstanceId: node, attemptOrdinal: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow('Identity ordinals must be non-negative safe integers.');
    expect(() =>
      createSubpipelineScopeId({
        parentScopeId: root,
        authoredNodeId: call,
        invocationOrdinal: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow('Identity ordinals must be non-negative safe integers.');
    expect(() =>
      createRepeatIterationScopeId({
        parentScopeId: root,
        authoredNodeId: call,
        iterationOrdinal: 0,
      }),
    ).toThrow('Repeat iteration ordinal must be positive.');
  });
});
