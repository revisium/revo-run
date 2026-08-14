import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { RunScope } from '../../contracts/run/run-details.js';
import { mapObservableScope } from './map-observable-scope.js';
import type {
  ObservableNodeCandidate,
  ObservablePlan,
  ObservableScopeCandidate,
} from './observable-plan.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

/** Owns scope ancestry, uniqueness, and traversal-ordered public projection. */
export class RunScopeObservationProjector {
  readonly scopes: RunScope[] = [];
  private readonly included = new Set<string>();

  constructor(private readonly plan: ObservablePlan) {}

  includeDurable(status: WorkflowStatus, candidate: DurableScopeCandidate): void {
    this.includeAncestors(candidate);
    const scope = mapObservableScope(status, candidate);
    if (this.included.has(scope.id)) {
      throw new Error('Observable scope was included more than once.');
    }
    this.scopes.push(scope);
    this.included.add(scope.id);
  }

  includeForNode(candidate: ObservableNodeCandidate): void {
    if (this.included.has(candidate.scopeId)) {
      return;
    }
    const scope = this.plan.scopes.get(candidate.scopeId);
    if (scope?.kind !== 'inlineSubpipeline') {
      throw new Error('Node belongs to an unobserved durable scope.');
    }
    this.includeAncestors(scope);
    this.includeInline(scope);
  }

  private includeAncestors(candidate: ObservableScopeCandidate): void {
    if (candidate.kind === 'root' || this.included.has(candidate.parentScopeId)) {
      return;
    }
    const parent = this.plan.scopes.get(candidate.parentScopeId);
    if (parent === undefined) {
      throw new Error('Observable scope parent was not found.');
    }
    if (parent.kind !== 'inlineSubpipeline') {
      throw new Error('Durable scope parent has not been observed.');
    }
    this.includeAncestors(parent);
    this.includeInline(parent);
  }

  private includeInline(
    candidate: Extract<ObservableScopeCandidate, { readonly kind: 'inlineSubpipeline' }>,
  ): void {
    if (this.included.has(candidate.id)) {
      return;
    }
    this.scopes.push({
      kind: 'inlineSubpipeline',
      id: candidate.id,
      parentScopeId: candidate.parentScopeId,
      pipelineId: candidate.pipelineId,
      displayPath: candidate.displayPath,
    });
    this.included.add(candidate.id);
  }
}
