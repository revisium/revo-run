import { describe, expect, it } from 'vitest';

import { runWorkflowId, scopeWorkflowId } from '../../src/dbos/workflow-id.js';

describe('DBOS workflow ID namespaces', () => {
  it('maps external run and opaque scope IDs deterministically into disjoint namespaces', () => {
    const run = runWorkflowId('Run_1');
    const scope = scopeWorkflowId(`sc1_${'a'.repeat(43)}`);

    expect(run).toBe('rr:run:Run_1');
    expect(scope).toBe(`rr:scope:sc1_${'a'.repeat(43)}`);
    expect(run).not.toBe(scope);
    expect(run).toContain(':');
    expect(scope).toContain(':');
  });
});
