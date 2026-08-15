import { DBOS, type WorkflowHandle } from '@dbos-inc/dbos-sdk';

import type { MapItemResult } from '../../contracts/workflow/map-item-result.js';
import type {
  MapItemDisposition,
  MapItemWorkflowInput,
} from '../../contracts/workflow/map-item-workflow-input.js';
import {
  createAuthoredNodeId,
  createMapItemScopeId,
  createNodeInstanceId,
} from '../../pipeline/identity/execution-identity.js';
import { runtimePath } from '../../pipeline/interpreter/node-path.js';
import { encodeMapItemPathSegment } from '../../pipeline/map/map-item-path.js';
import type { MapItemExecution, PreparedMapItem } from '../../pipeline/map/map-item-runner.js';
import { parseMapItemResult } from '../../validation/map-item-result.validator.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { MapItemWorkflowProvider } from '../workflows/map-item-workflow-provider.js';

export type ActiveMapItemDisposition = MapItemDisposition | 'discarded';

export interface ActiveMapItem {
  readonly item: PreparedMapItem;
  readonly disposition: ActiveMapItemDisposition;
  readonly handle: WorkflowHandle<MapItemResult>;
}

export interface SettledMapItem {
  readonly item: PreparedMapItem;
  readonly disposition: ActiveMapItemDisposition;
  readonly result: MapItemResult;
}

export interface MapItemScopeState {
  readonly input: MapItemExecution;
  readonly pending: PreparedMapItem[];
  readonly active: Map<string, ActiveMapItem>;
  readonly admitted: PreparedMapItem[];
}

export class DbosMapItemScopeController {
  constructor(
    private readonly workflows: MapItemWorkflowProvider,
    private readonly coordinator: RunCoordinatorClient,
  ) {}

  async startNext(state: MapItemScopeState, disposition: MapItemDisposition): Promise<void> {
    const item = state.pending.shift();
    if (item === undefined) {
      return;
    }
    const { input } = state;
    const authoredNodeId = this.authoredNodeId(input);
    const scopeId = createMapItemScopeId({
      parentScopeId: input.context.scopeId,
      authoredNodeId,
      itemKey: item.itemKey,
    });
    const parentWorkflowId = DBOS.workflowID;
    if (!parentWorkflowId?.startsWith('rr:scope:')) {
      throw new Error('Map item parent has no workflow ID.');
    }
    const workflowId = scopeWorkflowId(scopeId);
    const startFence = await this.coordinator.admitScope(workflowId);
    const durableInput: MapItemWorkflowInput = {
      runId: input.context.runId,
      scopeId,
      parentScopeId: input.context.scopeId,
      mapNodeInstanceId: createNodeInstanceId({
        scopeId: input.context.scopeId,
        authoredNodeId,
      }),
      sourceIndex: item.sourceIndex,
      itemKey: item.itemKey,
      item: item.value,
      node: input.node.body,
      pipelineId: input.context.pipelineId,
      pipelineInput: input.context.pipelineInput,
      runtimePath: `${runtimePath(input.context, input.nodePath)}[${encodeMapItemPathSegment(item.itemKey)}]`,
      parentPath: input.nodePath,
      inheritedOutputs: [...input.context.outputs].map(([path, output]) => ({ path, output })),
      maximumParallelism: input.context.maximumParallelism,
      parentWorkflowId,
      disposition,
      startFence,
      ...(input.context.iterationInput === undefined
        ? {}
        : { iterationInput: input.context.iterationInput }),
    };
    const handle = await DBOS.startWorkflow(this.workflows.get(), {
      workflowID: workflowId,
    })(durableInput);
    if (handle.workflowID !== workflowId) {
      throw new Error('Map item started with an unexpected workflow ID.');
    }
    state.admitted.push(item);
    state.active.set(workflowId, { item, disposition, handle });
  }

  async settleFirst(active: Map<string, ActiveMapItem>): Promise<SettledMapItem> {
    const handle = await DBOS.waitFirst([...active.values()].map(({ handle: child }) => child));
    const entry = active.get(handle.workflowID);
    if (entry === undefined) {
      throw new Error('DBOS completed an unknown map item workflow.');
    }
    const result = parseMapItemResult(await entry.handle.getResult());
    if (result.sourceIndex !== entry.item.sourceIndex || result.itemKey !== entry.item.itemKey) {
      throw new Error('Map item workflow returned another item identity.');
    }
    active.delete(handle.workflowID);
    return { item: entry.item, disposition: entry.disposition, result };
  }

  async cancelAndDiscardActive(
    active: Map<string, ActiveMapItem>,
    nodeInstanceId: string,
  ): Promise<void> {
    const workflowIds = [...active.keys()];
    for (const [workflowId, item] of active) {
      active.set(workflowId, { ...item, disposition: 'discarded' });
    }
    await this.coordinator.cancelScopes(workflowIds, nodeInstanceId);
  }

  nodeInstanceId(input: MapItemExecution): string {
    return createNodeInstanceId({
      scopeId: input.context.scopeId,
      authoredNodeId: this.authoredNodeId(input),
    });
  }

  private authoredNodeId(input: MapItemExecution): string {
    return createAuthoredNodeId({
      schemaVersion: input.context.plan.schemaVersion,
      pipelineId: input.context.pipelineId,
      nodePath: input.nodePath,
      nodeKind: 'map',
    });
  }
}
