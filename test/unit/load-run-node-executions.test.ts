import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestStep = {
  readonly childWorkflowID: string | null;
  readonly error: null;
  readonly name: string;
  readonly output: unknown;
};

const dbos = vi.hoisted(() => ({
  listWorkflowSteps: vi.fn<(workflowId: string) => Promise<readonly TestStep[]>>(),
}));

const rootWorkflowId = 'rr:run:v2:Run_1';
const sharedScopeWorkflowId = `rr:scope:v2:sc1_${'e'.repeat(43)}`;

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { nodeExecutionStepName } from '../../src/dbos/dbos-names.js';
import { loadRunNodeExecutions } from '../../src/dbos/read-model/load-run-node-executions.js';

const execution = {
  kind: 'runNodeExecution',
  request: {
    runId: 'run-1',
    authoredNodeId: `an1_${'a'.repeat(43)}`,
    scopeId: `sc1_${'b'.repeat(43)}`,
    nodeInstanceId: `ni1_${'c'.repeat(43)}`,
    attemptId: `at1_${'d'.repeat(43)}`,
    attemptOrdinal: 1,
    displayPath: 'main/work',
    pipelineId: 'main',
    nodePath: 'work',
    binding: {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work' },
      script: { id: 'example.run', revision: 1 },
    },
    input: {},
  },
  result: { kind: 'completed', outcome: 'completed' },
} as const;

const childStep = (childWorkflowID: string) => ({
  childWorkflowID,
  error: null,
  name: 'start-child',
  output: null,
});

describe('run node execution traversal', () => {
  beforeEach(() => dbos.listWorkflowSteps.mockReset());

  it('does not double-count one mapped child referenced by multiple DBOS steps', async () => {
    dbos.listWorkflowSteps.mockImplementation(async (workflowId: string) => {
      if (workflowId === rootWorkflowId) {
        return [childStep(sharedScopeWorkflowId), childStep(sharedScopeWorkflowId)];
      }
      if (workflowId === sharedScopeWorkflowId) {
        return [
          {
            childWorkflowID: null,
            error: null,
            name: nodeExecutionStepName('main/work'),
            output: execution,
          },
        ];
      }
      return [];
    });

    await expect(loadRunNodeExecutions(rootWorkflowId)).resolves.toEqual([execution]);
  });
});
