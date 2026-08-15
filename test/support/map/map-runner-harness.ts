import { DBOS } from '@dbos-inc/dbos-sdk';
import { vi } from 'vitest';

import type { MapNode } from '../../../src/contracts/pipeline/pipeline-node.js';
import type { MapItemResult } from '../../../src/contracts/workflow/map-item-result.js';
import type { MapItemWorkflowInput } from '../../../src/contracts/workflow/map-item-workflow-input.js';
import { RunCoordinatorClient } from '../../../src/dbos/coordination/run-coordinator-client.js';
import { DbosMapItemRunner } from '../../../src/dbos/map/dbos-map-item-runner.js';
import { MapItemWorkflowProvider } from '../../../src/dbos/workflows/map-item-workflow-provider.js';
import type { PipelineExecutionContext } from '../../../src/pipeline/interpreter/interpreter-context.js';
import type { MapItemExecution } from '../../../src/pipeline/map/map-item-runner.js';
import { executionPlan, task } from '../../dsl/pipeline-builder.js';

const physicalWorkflowId = `rr:scope:sc1_${'a'.repeat(43)}`;
const scopeId = physicalWorkflowId.slice('rr:scope:'.length);

export const mapNode = (
  failure: MapNode['failure'] = { kind: 'collect' },
  concurrency = 2,
): MapNode => ({
  kind: 'map',
  key: 'repositories',
  items: { kind: 'runInput', path: '/items' },
  itemKeyPath: '/key',
  maximumItems: 10,
  concurrency,
  failure,
  body: task('review'),
});

const contextFor = (node: MapNode): PipelineExecutionContext => ({
  plan: executionPlan(node),
  runId: 'run-1',
  scopeId,
  runInput: null,
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main',
  outputs: new Map(),
  maximumParallelism: 3,
});

export const execution = (node: MapNode, keys: readonly string[]): MapItemExecution => ({
  node,
  context: contextFor(node),
  nodePath: 'repositories',
  items: keys.map((itemKey, sourceIndex) => ({
    sourceIndex,
    itemKey,
    value: { key: itemKey },
  })),
});

export const continued = (
  sourceIndex: number,
  itemKey: string,
  outcome = 'completed',
): MapItemResult => ({
  kind: 'continued',
  sourceIndex,
  itemKey,
  outcome,
});

export const terminal = (sourceIndex: number, itemKey: string): MapItemResult => ({
  kind: 'terminal',
  sourceIndex,
  itemKey,
  result: { status: 'failed', outcome: 'event_budget_exceeded' },
});

interface MapRunnerHarness {
  readonly cancelScopes: ReturnType<typeof vi.fn<RunCoordinatorClient['cancelScopes']>>;
  readonly decisions: unknown[];
  readonly inputs: MapItemWorkflowInput[];
  readonly runner: DbosMapItemRunner;
}

export const mapRunnerHarness = (
  results: Readonly<Record<string, unknown>>,
  settlementOrder: readonly string[],
  lifecycle?: string[],
): MapRunnerHarness => {
  const inputs: MapItemWorkflowInput[] = [];
  const decisions: unknown[] = [];
  const keyByWorkflowId = new Map<string, string>();
  vi.spyOn(DBOS, 'startWorkflow').mockImplementation(
    (_workflow, options) => async (input: MapItemWorkflowInput) => {
      if (options?.workflowID === undefined) {
        throw new Error('Expected a deterministic map workflow ID.');
      }
      const result =
        results[input.itemKey] ??
        (input.disposition === 'settlementOnly'
          ? { kind: 'settlementOnly', sourceIndex: input.sourceIndex, itemKey: input.itemKey }
          : undefined);
      if (result === undefined) {
        throw new Error(`No map result for ${input.itemKey}.`);
      }
      inputs.push(input);
      lifecycle?.push(`start:${input.itemKey}:${input.disposition}`);
      keyByWorkflowId.set(options.workflowID, input.itemKey);
      return { workflowID: options.workflowID, getResult: async () => result };
    },
  );
  const order = [...settlementOrder];
  vi.spyOn(DBOS, 'waitFirst').mockImplementation(async (active) => {
    const key = order.shift();
    const handle = active.find((candidate) => keyByWorkflowId.get(candidate.workflowID) === key);
    if (handle === undefined) {
      throw new Error(`Settlement ${String(key)} is not active.`);
    }
    lifecycle?.push(`settle:${String(key)}`);
    return handle;
  });
  vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => {
    const decision = await callback();
    decisions.push(decision);
    lifecycle?.push('decision');
    return decision;
  });
  vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(physicalWorkflowId);

  const cancelScopes = vi.fn<RunCoordinatorClient['cancelScopes']>(async () => {
    lifecycle?.push('cancel');
  });
  const coordinator = new RunCoordinatorClient('run-1');
  coordinator.admitScope = async (workflowId: string) => ({
    directive: 'start' as const,
    requestId: `request:${workflowId}`,
    admissionId: `admission:${workflowId}`,
    workflowId,
  });
  coordinator.cancelScopes = cancelScopes;
  const workflows = new MapItemWorkflowProvider();
  workflows.register(async () => Promise.reject(new Error('Workflow should be mocked.')));
  return {
    cancelScopes,
    decisions,
    inputs,
    runner: new DbosMapItemRunner(workflows, coordinator),
  };
};
