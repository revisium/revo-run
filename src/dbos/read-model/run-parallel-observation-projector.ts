import type {
  ParallelJoinObservation,
  SkippedParallelBranch,
} from '../../contracts/run/run-details.js';
import { parseDurableParallelJoinDecision } from '../../validation/parallel-join-decision.validator.js';
import { parseScopeStartFenceReply } from '../../validation/run-coordinator-message.validator.js';
import {
  isParallelJoinDecisionStepName,
  parallelBranchWorkflowName,
  parallelJoinDecisionDisplayPath,
} from '../dbos-names.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { DbosStepRecord } from './dbos-step-pages.js';
import { mapParallelJoinObservation } from './map-parallel-join-observation.js';
import type {
  ObservableParallelCandidate,
  ObservablePlan,
  ObservableScopeCandidate,
} from './observable-plan.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

/** Owns durable join integrity validation and public projection ordering. */
export class RunParallelObservationProjector {
  readonly observations: ParallelJoinObservation[] = [];
  readonly skippedBranches: SkippedParallelBranch[] = [];
  private readonly includedNodeInstances = new Set<string>();

  constructor(
    private readonly plan: ObservablePlan,
    private readonly authoritativeTerminal: boolean,
  ) {}

  finish(): void {
    this.observations.sort(
      (left, right) =>
        left.scopeId.localeCompare(right.scopeId) ||
        left.nodeInstanceId.localeCompare(right.nodeInstanceId),
    );
    const joinOrder = new Map(
      this.observations.map(({ nodeInstanceId }, index) => [nodeInstanceId, index]),
    );
    this.skippedBranches.sort(
      (left, right) =>
        (joinOrder.get(left.nodeInstanceId) ?? Number.MAX_SAFE_INTEGER) -
        (joinOrder.get(right.nodeInstanceId) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  includeScopeSteps(steps: readonly DbosStepRecord[], physicalScope: DurableScopeCandidate): void {
    for (const step of steps) {
      if (isParallelJoinDecisionStepName(step.name)) {
        this.include(step, steps, physicalScope);
      }
    }
  }

  private include(
    step: DbosStepRecord,
    scopeSteps: readonly DbosStepRecord[],
    physicalScope: DurableScopeCandidate,
  ): void {
    if (step.error !== null) {
      throw new Error('Parallel join decision step failed.');
    }
    const displayPath = parallelJoinDecisionDisplayPath(step.name);
    const candidate = this.plan.parallelNodesByDisplayPath.get(displayPath);
    if (candidate?.physicalScopeId !== physicalScope.id) {
      throw new Error('Parallel join decision is not present in its admitted scope.');
    }
    if (this.includedNodeInstances.has(candidate.nodeInstanceId)) {
      throw new Error('Parallel join decision is duplicated.');
    }
    const admittedBranchKeys = this.admittedBranchKeys(candidate, scopeSteps);
    const projection = mapParallelJoinObservation(
      candidate,
      parseDurableParallelJoinDecision(step.output),
      admittedBranchKeys,
      this.authoritativeTerminal,
    );
    this.observations.push(projection.observation);
    this.skippedBranches.push(...projection.skippedBranches);
    this.includedNodeInstances.add(candidate.nodeInstanceId);
  }

  private admittedBranchKeys(
    candidate: ObservableParallelCandidate,
    steps: readonly DbosStepRecord[],
  ): ReadonlySet<string> {
    const startedWorkflowIds = new Set(
      steps.flatMap(({ name, childWorkflowID }) =>
        name === parallelBranchWorkflowName && childWorkflowID !== null ? [childWorkflowID] : [],
      ),
    );
    const admittedWorkflowIds = new Set(
      steps.flatMap(({ name, output }) => {
        if (
          name !== 'DBOS.recv' ||
          typeof output !== 'object' ||
          output === null ||
          !('directive' in output) ||
          (output.directive !== 'start' && output.directive !== 'startCancelled')
        ) {
          return [];
        }
        return [parseScopeStartFenceReply(output).workflowId];
      }),
    );
    const startedWithoutAdmission = [...startedWorkflowIds].some(
      (workflowId) => !admittedWorkflowIds.has(workflowId),
    );
    const terminalAdmissionWithoutStart =
      this.authoritativeTerminal && startedWorkflowIds.size !== admittedWorkflowIds.size;
    if (startedWithoutAdmission || terminalAdmissionWithoutStart) {
      throw new Error('Parallel child admission and start records are inconsistent.');
    }
    return new Set(
      [...candidate.branchScopeIds].flatMap(([branchKey, scopeId]) =>
        admittedWorkflowIds.has(scopeWorkflowId(scopeId)) ? [branchKey] : [],
      ),
    );
  }
}
