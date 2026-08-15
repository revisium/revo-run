import type { JsonValue } from '../../contracts/json-value.js';
import type { MapNode } from '../../contracts/pipeline/pipeline-node.js';
import { InputResolver } from '../data/input-resolver.js';
import { readJsonPointer } from '../data/json-pointer.js';
import type { MapItemRunner, PreparedMapItem } from '../map/map-item-runner.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import { pipelineNodeEventIdentity, type PipelineEventSink } from './pipeline-event-sink.js';
import { PipelineFailureReporter } from './pipeline-failure-reporter.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

type PreflightResult =
  | { readonly valid: true; readonly items: readonly PreparedMapItem[] }
  | {
      readonly valid: false;
      readonly errorCode:
        | 'duplicate_map_item_key'
        | 'invalid_map_item_key'
        | 'map_item_key_not_found';
    };

export class MapNodeExecutor {
  private readonly failures: PipelineFailureReporter;

  constructor(
    private readonly items: MapItemRunner,
    private readonly events: PipelineEventSink,
  ) {
    this.failures = new PipelineFailureReporter(events);
  }

  async execute(
    node: MapNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const resolved = new InputResolver(context).resolve(node.items);
    if (!resolved.resolved) {
      return this.failures.inputResolutionFailed(node, context, nodePath, resolved.errorCode);
    }
    if (resolved.value.kind !== 'json' || !Array.isArray(resolved.value.value)) {
      return this.failures.invalidNode(node, context, nodePath, 'map_items_not_array');
    }
    if (resolved.value.value.length > node.maximumItems) {
      await this.events.write({
        type: 'map.limitExceeded',
        data: pipelineNodeEventIdentity(node, context, nodePath),
      });
      return continuedExecution('limitExceeded', runtimePath(context, nodePath));
    }
    const preflight = this.preflightItems(resolved.value.value, node.itemKeyPath);
    if (!preflight.valid) {
      return this.failures.invalidNode(node, context, nodePath, preflight.errorCode);
    }

    const result = await this.items.execute({ node, context, nodePath, items: preflight.items });
    if (result.kind === 'terminal') {
      return terminalExecution(result.result);
    }
    context.outputs.set(nodePath, result.output);
    return continuedExecution(result.outcome, runtimePath(context, nodePath), result.output);
  }

  private preflightItems(items: readonly JsonValue[], itemKeyPath: string): PreflightResult {
    const prepared: PreparedMapItem[] = [];
    const itemKeys = new Set<string>();
    for (const [sourceIndex, item] of items.entries()) {
      const selected = readJsonPointer(item, itemKeyPath);
      if (!selected.found) {
        return { valid: false, errorCode: 'map_item_key_not_found' };
      }
      if (typeof selected.value !== 'string' || selected.value.length === 0) {
        return { valid: false, errorCode: 'invalid_map_item_key' };
      }
      if (itemKeys.has(selected.value)) {
        return { valid: false, errorCode: 'duplicate_map_item_key' };
      }
      itemKeys.add(selected.value);
      prepared.push({ sourceIndex, itemKey: selected.value, value: item });
    }
    return { valid: true, items: prepared };
  }
}
