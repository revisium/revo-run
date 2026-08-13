import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type {
  RunAttempt,
  RunDetails,
  RunNodeInstance,
  RunScope,
  RunCommandDetails,
} from '../../contracts/run/run-details.js';
import type { RunSnapshot } from '../../contracts/run/run.js';
import { parseDbosWorkflowStatus } from '../../validation/dbos-workflow-status.validator.js';
import { parseRunCommandDecision } from '../../validation/run-command-workflow.validator.js';
import { parseUnknownResolutionDirective } from '../../validation/run-command-workflow.validator.js';
import {
  isNodeAttemptOutcomeStepName,
  isUnknownOutcomeReadyStepName,
  isRunCommandDecisionStepName,
  runCommandDecisionCommandId,
  nodeAttemptStepIdentity,
  parallelBranchWorkflowName,
  runExecutionWorkflowName,
  runExecutionWorkflowV2Name,
  parallelBranchWorkflowV2Name,
  unknownOutcomeReadyAttemptId,
} from '../dbos-names.js';
import { isUnknownOutcomeResolutionStepName } from '../dbos-names.js';
import { runWorkflowId } from '../workflow-id.js';
import { loadAllWorkflowSteps, type DbosStepRecord } from './dbos-step-pages.js';
import { mapObservableScope, scopeCandidateFromStatus } from './map-observable-scope.js';
import { mapRunAttempt } from './map-run-attempt.js';
import { mapRunCommandDecision } from './map-run-command-decision.js';
import {
  buildObservablePlan,
  type ObservableNodeCandidate,
  type ObservablePlan,
  type ObservableScopeCandidate,
} from './observable-plan.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

const introducedScopeWorkflow = (
  step: DbosStepRecord,
  introduced: ReadonlySet<string>,
  version: 'v1' | 'v2',
): string | undefined => {
  if (step.childWorkflowID === null) {
    return undefined;
  }
  const names =
    version === 'v1'
      ? [runExecutionWorkflowName, parallelBranchWorkflowName]
      : [runExecutionWorkflowV2Name, parallelBranchWorkflowV2Name];
  if (names.includes(step.name)) {
    return step.childWorkflowID;
  }
  if (step.name === 'DBOS.getResult' && introduced.has(step.childWorkflowID)) {
    return undefined;
  }
  throw new Error('Run contains an unsupported child workflow link.');
};

class RunDetailsLoader {
  private readonly run: RunSnapshot;
  private readonly plan: ObservablePlan;
  private readonly scopes: RunScope[] = [];
  private readonly nodeInstances: RunNodeInstance[] = [];
  private readonly attempts: RunAttempt[] = [];
  private readonly commands: RunCommandDetails[] = [];
  private readonly version: 'v1' | 'v2';
  private readonly includedScopes = new Set<string>();
  private readonly nodeIndexes = new Map<string, number>();
  private readonly includedAttempts = new Set<string>();
  private readonly visitedWorkflows = new Set<string>();
  private readonly activeWorkflows = new Set<string>();

  constructor(run: RunSnapshot, version: 'v1' | 'v2') {
    this.run = run;
    this.plan = buildObservablePlan(run.executionPlan, run.id);
    this.version = version;
  }

  async load(): Promise<RunDetails> {
    const wrapperSteps = await loadAllWorkflowSteps(runWorkflowId(this.run.id));
    this.includeCommandDecisions(wrapperSteps);
    await this.visitIntroducedScopes(wrapperSteps);
    return {
      run: this.run,
      scopes: this.scopes,
      nodeInstances: this.nodeInstances,
      attempts: this.attempts,
      commands: this.commands,
    };
  }

  private async visitWorkflow(workflowId: string): Promise<void> {
    if (this.activeWorkflows.has(workflowId) || this.visitedWorkflows.has(workflowId)) {
      throw new Error('DBOS scope workflow graph contains a cycle or duplicate.');
    }
    this.activeWorkflows.add(workflowId);
    this.visitedWorkflows.add(workflowId);
    try {
      const status = await this.loadWorkflowStatus(workflowId);
      const candidate = scopeCandidateFromStatus(
        status,
        this.run.id,
        this.plan.scopes,
        this.version,
      );
      this.includeScopeAncestors(candidate);
      this.includeDurableScope(mapObservableScope(status, candidate));

      const steps = await loadAllWorkflowSteps(workflowId);
      await this.visitScopeSteps(steps, candidate);
    } finally {
      this.activeWorkflows.delete(workflowId);
    }
  }

  private async visitIntroducedScopes(steps: readonly DbosStepRecord[]): Promise<void> {
    const introduced = new Set<string>();
    await steps.reduce<Promise<void>>(async (previous, step) => {
      await previous;
      const childWorkflowId = introducedScopeWorkflow(step, introduced, this.version);
      if (childWorkflowId !== undefined) {
        introduced.add(childWorkflowId);
        await this.visitWorkflow(childWorkflowId);
      }
    }, Promise.resolve());
  }

  private async visitScopeSteps(
    steps: readonly DbosStepRecord[],
    candidate: DurableScopeCandidate,
  ): Promise<void> {
    const introduced = new Set<string>();
    const readyUnknownOutcomes = new Set(
      steps
        .filter(({ name }) => isUnknownOutcomeReadyStepName(name))
        .map(({ name }) => unknownOutcomeReadyAttemptId(name)),
    );
    await steps.reduce<Promise<void>>(async (previous, step) => {
      await previous;
      if (isNodeAttemptOutcomeStepName(step.name)) {
        this.includeAttempt(step, candidate, readyUnknownOutcomes);
      }
      if (isUnknownOutcomeResolutionStepName(step.name)) {
        this.includeUnknownOutcomeResolution(step);
      }
      const childWorkflowId = introducedScopeWorkflow(step, introduced, this.version);
      if (childWorkflowId !== undefined) {
        introduced.add(childWorkflowId);
        await this.visitWorkflow(childWorkflowId);
      }
    }, Promise.resolve());
  }

  private includeCommandDecisions(steps: readonly DbosStepRecord[]): void {
    if (this.version === 'v1') {
      return;
    }
    for (const step of steps) {
      if (!isRunCommandDecisionStepName(step.name)) {
        continue;
      }
      if (step.error !== null) {
        throw new Error('Run command decision step failed.');
      }
      const decision = parseRunCommandDecision(step.output);
      if (decision.commandId !== runCommandDecisionCommandId(step.name)) {
        throw new Error('Run command decision identity is invalid.');
      }
      this.commands.push(mapRunCommandDecision(decision));
    }
  }

  private includeUnknownOutcomeResolution(step: DbosStepRecord): void {
    if (step.error !== null) {
      throw new Error('Unknown outcome resolution step failed.');
    }
    const resolution = parseUnknownResolutionDirective(step.output);
    if (resolution.kind === 'cancel' || resolution.kind === 'fail' || resolution.kind === 'retry') {
      return;
    }
    const attemptId = step.name.slice('unknown-outcome-resolution:'.length);
    const attempt = this.attempts.find(({ id }) => id === attemptId);
    if (attempt?.status !== 'outcomeUnknown') {
      throw new Error('Unknown outcome resolution has no immutable unknown attempt.');
    }
    const nodeIndex = this.nodeIndexes.get(attempt.nodeInstanceId);
    const node = nodeIndex === undefined ? undefined : this.nodeInstances[nodeIndex];
    if (nodeIndex === undefined || node === undefined) {
      throw new Error('Unknown outcome resolution node was not found.');
    }
    this.nodeInstances[nodeIndex] = {
      ...node,
      status: resolution.kind === 'adoptSuccess' ? 'completed' : 'failed',
      ...(step.completedAtEpochMs === undefined
        ? {}
        : { completedAt: new Date(step.completedAtEpochMs) }),
    };
  }

  private async loadWorkflowStatus(workflowId: string): Promise<WorkflowStatus> {
    const status = await DBOS.getWorkflowStatus(workflowId);
    if (status === null) {
      throw new Error('DBOS scope workflow status was not found.');
    }
    return parseDbosWorkflowStatus(status);
  }

  private includeScopeAncestors(candidate: ObservableScopeCandidate): void {
    if (candidate.kind === 'root') {
      return;
    }
    if (this.includedScopes.has(candidate.parentScopeId)) {
      return;
    }
    const parent = this.plan.scopes.get(candidate.parentScopeId);
    if (parent === undefined) {
      throw new Error('Observable scope parent was not found.');
    }
    if (parent.kind !== 'inlineSubpipeline') {
      throw new Error('Durable scope parent has not been observed.');
    }
    this.includeScopeAncestors(parent);
    this.includeInlineScope(parent);
  }

  private includeInlineScope(candidate: ObservableScopeCandidate): void {
    if (candidate.kind !== 'inlineSubpipeline') {
      throw new Error('Inline scope candidate is invalid.');
    }
    if (this.includedScopes.has(candidate.id)) {
      return;
    }
    this.scopes.push({
      kind: 'inlineSubpipeline',
      id: candidate.id,
      parentScopeId: candidate.parentScopeId,
      pipelineId: candidate.pipelineId,
      displayPath: candidate.displayPath,
    });
    this.includedScopes.add(candidate.id);
  }

  private includeDurableScope(
    scope: Exclude<RunScope, { readonly kind: 'inlineSubpipeline' }>,
  ): void {
    if (this.includedScopes.has(scope.id)) {
      throw new Error('Observable scope was included more than once.');
    }
    this.scopes.push(scope);
    this.includedScopes.add(scope.id);
  }

  private includeAttempt(
    step: DbosStepRecord,
    physicalScope: DurableScopeCandidate,
    readyUnknownOutcomes: ReadonlySet<string>,
  ): void {
    const stepIdentity = nodeAttemptStepIdentity(step.name);
    const candidate = this.plan.nodesByDisplayPath.get(stepIdentity.displayPath);
    if (candidate?.physicalScopeId !== physicalScope.id) {
      throw new Error('DBOS node step is not present in its admitted scope.');
    }
    const attempt = mapRunAttempt(step, candidate, this.run.id, stepIdentity.attemptOrdinal);
    if (attempt === undefined) {
      return;
    }
    if (
      this.version === 'v2' &&
      attempt.status === 'outcomeUnknown' &&
      candidate.awaitsHumanResolution &&
      !readyUnknownOutcomes.has(attempt.id)
    ) {
      return;
    }
    this.includeScopeForNode(candidate);
    if (this.includedAttempts.has(attempt.id)) {
      throw new Error('DBOS node attempt is duplicated.');
    }
    const nodeIndex = this.nodeIndexes.get(candidate.id);
    const previous = nodeIndex === undefined ? undefined : this.nodeInstances[nodeIndex];
    if (attempt.ordinal !== (previous?.attemptIds.length ?? 0) + 1) {
      throw new Error('DBOS node attempts are not contiguous.');
    }
    this.attempts.push(attempt);
    const nodeInstance: RunNodeInstance = {
      id: candidate.id,
      scopeId: candidate.scopeId,
      authoredNodeId: candidate.authoredNodeId,
      pipelineId: candidate.pipelineId,
      nodePath: candidate.nodePath,
      displayPath: candidate.displayPath,
      status: attempt.status,
      attemptIds: [...(previous?.attemptIds ?? []), attempt.id],
      ...(previous?.startedAt === undefined && attempt.startedAt === undefined
        ? {}
        : { startedAt: previous?.startedAt ?? attempt.startedAt }),
      ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
    };
    if (nodeIndex === undefined) {
      this.nodeIndexes.set(candidate.id, this.nodeInstances.length);
      this.nodeInstances.push(nodeInstance);
    } else {
      this.nodeInstances[nodeIndex] = nodeInstance;
    }
    this.includedAttempts.add(attempt.id);
  }

  private includeScopeForNode(candidate: ObservableNodeCandidate): void {
    if (this.includedScopes.has(candidate.scopeId)) {
      return;
    }
    const scope = this.plan.scopes.get(candidate.scopeId);
    if (scope?.kind !== 'inlineSubpipeline') {
      throw new Error('Node belongs to an unobserved durable scope.');
    }
    this.includeScopeAncestors(scope);
    this.includeInlineScope(scope);
  }
}

export const loadRunDetails = (
  run: RunSnapshot,
  version: 'v1' | 'v2' = 'v1',
): Promise<RunDetails> => new RunDetailsLoader(run, version).load();
