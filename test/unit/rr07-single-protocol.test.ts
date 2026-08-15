import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerWorkflow = vi.hoisted(() =>
  vi.fn<(workflow: unknown, _options?: Readonly<Record<string, unknown>>) => unknown>(
    (workflow) => workflow,
  ),
);

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  const dbos = new Proxy(actual.DBOS, {
    get(target, property, receiver): unknown {
      if (property === 'registerWorkflow') {
        return registerWorkflow;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  return { ...actual, DBOS: dbos };
});

import {
  commandDispatchWorkflowName,
  mapItemWorkflowName,
  parallelBranchWorkflowName,
  repeatIterationWorkflowName,
  runExecutionWorkflowName,
  runWorkflowName,
} from '../../src/dbos/dbos-names.js';
import { mapRunSnapshot } from '../../src/dbos/read-model/map-run-snapshot.js';
import { commandWorkflowId, runWorkflowId, scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const runId = 'Run_1';
const input = {
  runId,
  admissionToken: 'a'.repeat(43),
  executionPlan: terminalExecutionPlan(),
  input: null,
};

const status = (workflowID: string, workflowName: string): WorkflowStatus => ({
  applicationID: 'test',
  createdAt: 1,
  input: [input],
  output: { status: 'cancelled', outcome: 'cancelled' },
  priority: 0,
  status: 'SUCCESS',
  updatedAt: 2,
  workflowClassName: '',
  workflowID,
  workflowName,
});

describe('single durable protocol', () => {
  beforeEach(() => registerWorkflow.mockClear());

  it('pins canonical workflow names and IDs without generation markers', () => {
    const commandId = 'cmd_00000000-0000-4000-8000-000000000000';
    expect([
      runWorkflowName,
      runExecutionWorkflowName,
      parallelBranchWorkflowName,
      mapItemWorkflowName,
      repeatIterationWorkflowName,
      commandDispatchWorkflowName,
    ]).toEqual([
      'revo-run.run',
      'revo-run.execution',
      'revo-run.parallel-branch',
      'revo-run.map-item',
      'revo-run.repeat-iteration',
      'revo-run.command-dispatch',
    ]);
    expect(runWorkflowId(runId)).toBe('rr:run:Run_1');
    expect(scopeWorkflowId('sc1_A')).toBe('rr:scope:sc1_A');
    expect(commandWorkflowId(commandId)).toBe(`rr:command:${commandId}`);
  });

  it('registers exactly one workflow of each current contract kind', () => {
    const registry = new WorkflowRegistry();
    expect(registerWorkflow).toHaveBeenCalledTimes(6);
    expect(registerWorkflow.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ name: mapItemWorkflowName }),
      expect.objectContaining({ name: parallelBranchWorkflowName }),
      expect.objectContaining({ name: repeatIterationWorkflowName }),
      expect.objectContaining({ name: runExecutionWorkflowName }),
      expect.objectContaining({ name: runWorkflowName }),
      expect.objectContaining({ name: commandDispatchWorkflowName }),
    ]);
    expect(registry).toHaveProperty('run');
    expect(registry).toHaveProperty('commandDispatch');
  });

  it('rejects noncanonical workflow names and foreign ID namespaces', () => {
    expect(() =>
      mapRunSnapshot(status(runWorkflowId(runId), 'foreign.workflow'), runWorkflowName, runId),
    ).toThrow('Workflow is not a Revo run.');
    expect(() =>
      mapRunSnapshot(status('foreign:run:Run_1', runWorkflowName), runWorkflowName, runId),
    ).toThrow('Workflow is not a Revo run.');
  });
});
