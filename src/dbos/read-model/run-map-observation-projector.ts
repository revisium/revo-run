import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { MapExecutionObservation, SkippedMapItem } from '../../contracts/run/run-details.js';
import type { DurableMapControlDecision } from '../../contracts/workflow/map-control-decision.js';
import type { MapItemResult } from '../../contracts/workflow/map-item-result.js';
import { createMapItemScopeId } from '../../pipeline/identity/execution-identity.js';
import { mapNodeOutput, summarizeMapItems } from '../../pipeline/map/map-result-summary.js';
import { parseDurableMapControlDecision } from '../../validation/map-control-decision.validator.js';
import { parseMapItemResult } from '../../validation/map-item-result.validator.js';
import { isMapControlDecisionStepName, mapControlDecisionDisplayPath } from '../dbos-names.js';
import type { DbosStepRecord } from './dbos-step-pages.js';
import type {
  ObservableMapCandidate,
  ObservablePlan,
  ObservableScopeCandidate,
} from './observable-plan.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

interface DeferredDecision {
  readonly candidate: ObservableMapCandidate;
  readonly decision: DurableMapControlDecision;
}

interface ObservedItem {
  readonly candidate: Extract<ObservableScopeCandidate, { readonly kind: 'mapItem' }>;
  readonly result: MapItemResult;
}

const itemIdentity = (item: { readonly sourceIndex: number; readonly itemKey: string }): string =>
  `${item.sourceIndex}\0${item.itemKey}`;

const isSourceOrdered = (
  items: readonly { readonly sourceIndex: number; readonly itemKey: string }[],
): boolean => {
  let previousSourceIndex = -1;
  for (const item of items) {
    if (item.sourceIndex <= previousSourceIndex) {
      return false;
    }
    previousSourceIndex = item.sourceIndex;
  }
  return true;
};

const followsItemOrder = (
  eligibleKeys: readonly string[],
  itemKeys: readonly string[],
): boolean => {
  let previousItemIndex = -1;
  for (const key of eligibleKeys) {
    const itemIndex = itemKeys.indexOf(key);
    if (itemIndex < previousItemIndex) {
      return false;
    }
    previousItemIndex = itemIndex;
  }
  return true;
};

/** Projects only persisted map control boundaries and validates their child scope evidence. */
export class RunMapObservationProjector {
  readonly observations: MapExecutionObservation[] = [];
  readonly skippedItems: SkippedMapItem[] = [];
  private readonly decisions = new Map<string, DeferredDecision>();
  private readonly itemsByNode = new Map<string, ObservedItem[]>();

  constructor(
    private readonly plan: ObservablePlan,
    private readonly authoritativeTerminal: boolean,
  ) {}

  includeScopeStatus(status: WorkflowStatus, candidate: DurableScopeCandidate): void {
    if (candidate.kind !== 'mapItem') {
      return;
    }
    if (status.status !== 'SUCCESS') {
      return;
    }
    const result = parseMapItemResult(status.output);
    if (
      result.sourceIndex !== candidate.mapIdentity.sourceIndex ||
      result.itemKey !== candidate.mapIdentity.itemKey
    ) {
      throw new Error('Map item observation result identity is invalid.');
    }
    const items = this.itemsByNode.get(candidate.mapIdentity.mapNodeInstanceId) ?? [];
    items.push({ candidate, result });
    this.itemsByNode.set(candidate.mapIdentity.mapNodeInstanceId, items);
  }

  includeScopeSteps(steps: readonly DbosStepRecord[], physicalScope: DurableScopeCandidate): void {
    for (const step of steps) {
      if (!isMapControlDecisionStepName(step.name)) {
        continue;
      }
      if (step.error !== null) {
        throw new Error('Map control decision step failed.');
      }
      const displayPath = mapControlDecisionDisplayPath(step.name);
      const candidate = this.plan.mapNodesByDisplayPath.get(displayPath);
      if (candidate?.physicalScopeId !== physicalScope.id) {
        throw new Error('Map control decision is not present in its admitted scope.');
      }
      if (this.decisions.has(candidate.nodeInstanceId)) {
        throw new Error('Map control decision is duplicated.');
      }
      this.decisions.set(candidate.nodeInstanceId, {
        candidate,
        decision: parseDurableMapControlDecision(step.output),
      });
    }
  }

  finish(): void {
    for (const deferred of this.decisions.values()) {
      this.project(deferred);
    }
    this.observations.sort(
      (left, right) =>
        left.scopeId.localeCompare(right.scopeId) ||
        left.nodeInstanceId.localeCompare(right.nodeInstanceId),
    );
    const order = new Map(
      this.observations.map(({ nodeInstanceId }, index) => [nodeInstanceId, index]),
    );
    this.skippedItems.sort(
      (left, right) =>
        (order.get(left.mapNodeInstanceId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.mapNodeInstanceId) ?? Number.MAX_SAFE_INTEGER) ||
        left.sourceIndex - right.sourceIndex,
    );
  }

  private project({ candidate, decision }: DeferredDecision): void {
    this.validateIdentity(candidate, decision);
    const actual = this.itemsByNode.get(candidate.nodeInstanceId) ?? [];
    const actualByIdentity = new Map(
      actual.map((item) => [itemIdentity(item.candidate.mapIdentity), item]),
    );
    if (actualByIdentity.size !== actual.length) {
      throw new Error('Map item observation contains duplicate identities.');
    }
    const expected = [
      ...decision.admitted.map((item) => ({ ...item, disposition: 'execute' as const })),
      ...decision.remaining.flatMap((item) =>
        item.disposition === 'drain' ? [{ ...item, disposition: 'settlementOnly' as const }] : [],
      ),
    ];
    const expectedByIdentity = new Map(expected.map((item) => [itemIdentity(item), item]));
    const observedMismatch = actual.some(({ candidate: observed }) => {
      const expectedItem = expectedByIdentity.get(itemIdentity(observed.mapIdentity));
      return expectedItem?.disposition !== observed.mapIdentity.disposition;
    });
    const terminalMissingItem =
      this.authoritativeTerminal &&
      expected.some((item) => !actualByIdentity.has(itemIdentity(item)));
    if (observedMismatch || terminalMissingItem) {
      throw new Error('Map child scopes do not match the durable control decision.');
    }

    const results = new Map(
      actual.map(({ candidate: item, result }) => [item.mapIdentity.itemKey, result]),
    );
    const allItems = [...decision.admitted, ...decision.remaining]
      .sort((left, right) => left.sourceIndex - right.sourceIndex)
      .map((item) => ({ ...item, value: null }));
    const summary = summarizeMapItems(allItems, decision.summaryEligibleItemKeys, results);
    const output = mapNodeOutput(summary);
    if (decision.control === 'allSettled') {
      this.observations.push({
        scopeId: decision.scopeId,
        nodeInstanceId: decision.nodeInstanceId,
        outcome: summary.failedItems === 0 ? 'completed' : 'completedWithErrors',
        summary: output.summary.value,
      });
      return;
    }
    if (candidate.node.failure.kind !== 'failFast') {
      throw new Error('Collecting map persisted a failure decision.');
    }
    this.observations.push({
      scopeId: decision.scopeId,
      nodeInstanceId: decision.nodeInstanceId,
      outcome: 'failed',
      remaining: candidate.node.failure.remaining,
      decisiveItemKey: decision.decisiveItemKey,
      summary: output.summary.value,
    });
    this.skippedItems.push(
      ...decision.remaining.flatMap(({ sourceIndex, itemKey, disposition }) =>
        disposition === 'cancel'
          ? [
              {
                mapNodeInstanceId: decision.nodeInstanceId,
                sourceIndex,
                itemKey,
                scopeId: createMapItemScopeId({
                  parentScopeId: candidate.scopeId,
                  authoredNodeId: candidate.authoredNodeId,
                  itemKey,
                }),
              },
            ]
          : [],
      ),
    );
  }

  private validateIdentity(
    candidate: ObservableMapCandidate,
    decision: DurableMapControlDecision,
  ): void {
    const all = [...decision.admitted, ...decision.remaining];
    const identities = all.map(itemIdentity);
    const keys = all.map(({ itemKey }) => itemKey);
    const eligible = new Set(decision.summaryEligibleItemKeys);
    const remainingPolicy =
      candidate.node.failure.kind === 'failFast' ? candidate.node.failure.remaining : undefined;
    if (
      decision.scopeId !== candidate.scopeId ||
      decision.nodeInstanceId !== candidate.nodeInstanceId ||
      !isSourceOrdered(decision.admitted) ||
      !isSourceOrdered(decision.remaining) ||
      new Set(identities).size !== identities.length ||
      new Set(keys).size !== keys.length ||
      decision.summaryEligibleItemKeys.some((key) => !keys.includes(key)) ||
      !followsItemOrder(decision.summaryEligibleItemKeys, keys) ||
      (decision.control === 'allSettled' && decision.remaining.length !== 0) ||
      (decision.control === 'failureDecided' &&
        (candidate.node.failure.kind !== 'failFast' ||
          !eligible.has(decision.decisiveItemKey) ||
          !decision.admitted.some(({ itemKey }) => itemKey === decision.decisiveItemKey) ||
          decision.remaining.some(({ disposition }) => disposition !== remainingPolicy)))
    ) {
      throw new Error('Map control decision semantics are invalid.');
    }
  }
}
