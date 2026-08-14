import { describe, expect, it } from 'vitest';

import { RunScopeRegistry } from '../../src/dbos/coordination/run-scope-registry.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { createSubpipelineScopeId } from '../../src/pipeline/identity/execution-identity.js';

const digest = (character: string): string => character.repeat(43);
const rootScopeId = `sc1_${digest('a')}`;
const rootWorkflowId = scopeWorkflowId(rootScopeId);
const childScopeId = `sc1_${digest('b')}`;
const childWorkflowId = scopeWorkflowId(childScopeId);
const otherScopeId = `sc1_${digest('c')}`;
const otherWorkflowId = scopeWorkflowId(otherScopeId);
const authoredNodeId = `an1_${digest('d')}`;
const nestedAuthoredNodeId = `an1_${digest('e')}`;

const inlineClaim = (workflowId: string, parentScopeId: string, authoredId = authoredNodeId) => ({
  workflowId,
  parentScopeId,
  scopeId: createSubpipelineScopeId({
    parentScopeId,
    authoredNodeId: authoredId,
    invocationOrdinal: 1,
  }),
  authoredNodeId: authoredId,
  invocationOrdinal: 1,
});

const registryWithReadyChildren = (): RunScopeRegistry => {
  const registry = new RunScopeRegistry();
  registry.registerRoot(rootWorkflowId, 'rr:run:run-1');
  registry.admitChild(childWorkflowId, rootWorkflowId, 'request:child', 'admission:child');
  registry.markReady(childWorkflowId);
  registry.admitChild(otherWorkflowId, rootWorkflowId, 'request:other', 'admission:other');
  registry.markReady(otherWorkflowId);
  return registry;
};

describe('RR-09 inline logical scope ownership', () => {
  it('registers root and nested inline ownership and replays identical claims', () => {
    const registry = registryWithReadyChildren();
    const first = inlineClaim(rootWorkflowId, rootScopeId);
    const nested = inlineClaim(rootWorkflowId, first.scopeId, nestedAuthoredNodeId);

    registry.registerInlineOwnership(first);
    registry.registerInlineOwnership(first);
    registry.registerInlineOwnership(nested);

    expect(registry.ownsScope(rootWorkflowId, rootScopeId)).toBe(true);
    expect(registry.ownsScope(rootWorkflowId, first.scopeId)).toBe(true);
    expect(registry.ownsScope(rootWorkflowId, nested.scopeId)).toBe(true);
  });

  it('registers inline descendants to repeat or parallel physical children', () => {
    const registry = registryWithReadyChildren();
    const claim = inlineClaim(childWorkflowId, childScopeId);

    registry.registerInlineOwnership(claim);

    expect(registry.ownsScope(childWorkflowId, claim.scopeId)).toBe(true);
    expect(registry.ownsScope(rootWorkflowId, claim.scopeId)).toBe(false);
  });

  it('rejects admission that is not ready or is no longer live', () => {
    const registry = new RunScopeRegistry();
    registry.registerRoot(rootWorkflowId, 'rr:run:run-1');
    registry.admitChild(childWorkflowId, rootWorkflowId, 'request:child', 'admission:child');
    const claim = inlineClaim(childWorkflowId, childScopeId);

    expect(() => registry.registerInlineOwnership(claim)).toThrow('not live');
    registry.markReady(childWorkflowId);
    registry.finish(childWorkflowId);
    expect(() => registry.registerInlineOwnership(claim)).toThrow('not live');
  });

  it('rejects forged identity, cross-owner parent use, and conflicting replay', () => {
    const registry = registryWithReadyChildren();
    const first = inlineClaim(rootWorkflowId, rootScopeId);
    registry.registerInlineOwnership(first);

    expect(() =>
      registry.registerInlineOwnership({ ...first, scopeId: `sc1_${digest('f')}` }),
    ).toThrow('identity');
    expect(() =>
      registry.registerInlineOwnership({ ...inlineClaim(otherWorkflowId, first.scopeId) }),
    ).toThrow('parent');
    expect(() =>
      registry.registerInlineOwnership({
        ...first,
        authoredNodeId: nestedAuthoredNodeId,
      }),
    ).toThrow('conflicting');
  });
});
