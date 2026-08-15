import type { MapNodeOutput, MapSummary } from '../../contracts/pipeline/map-output.js';
import type { MapItemResult } from '../../contracts/workflow/map-item-result.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';
import type { PreparedMapItem } from './map-item-runner.js';

export type ClassifiedMapItemResult =
  | { readonly kind: 'item'; readonly successful: boolean; readonly outcome: string }
  | { readonly kind: 'terminal'; readonly result: TerminalWorkflowResult }
  | { readonly kind: 'settlementOnly' };

export const classifyMapItemResult = (result: MapItemResult): ClassifiedMapItemResult => {
  switch (result.kind) {
    case 'continued':
      return { kind: 'item', successful: result.outcome === 'completed', outcome: result.outcome };
    case 'authoredEnd':
      return {
        kind: 'item',
        successful: result.result.status === 'succeeded',
        outcome: result.result.outcome,
      };
    case 'terminal':
      return { kind: 'terminal', result: result.result };
    case 'settlementOnly':
      return { kind: 'settlementOnly' };
  }
  result satisfies never;
  return result;
};

export const summarizeMapItems = (
  items: readonly PreparedMapItem[],
  eligibleItemKeys: readonly string[],
  results: ReadonlyMap<string, MapItemResult>,
): MapSummary => {
  const eligible = new Set(eligibleItemKeys);
  let completedItems = 0;
  const failures: { itemKey: string; outcome: string }[] = [];
  for (const item of items) {
    if (!eligible.has(item.itemKey)) {
      continue;
    }
    const result = results.get(item.itemKey);
    if (result === undefined) {
      throw new Error('Map summary is missing an eligible item result.');
    }
    const classified = classifyMapItemResult(result);
    if (classified.kind !== 'item') {
      throw new Error('Map summary contains a non-authoritative item result.');
    }
    if (classified.successful) {
      completedItems += 1;
    } else {
      failures.push({ itemKey: item.itemKey, outcome: classified.outcome });
    }
  }
  return {
    totalItems: items.length,
    completedItems,
    failedItems: failures.length,
    failures,
  };
};

export const mapNodeOutput = (summary: MapSummary): MapNodeOutput => ({
  summary: { kind: 'json', value: summary },
});
