import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type {
  RunAttempt,
  RunDetails,
  RunNodeInstance,
  RunCommandDetails,
} from '../../contracts/run/run-details.js';
import type { RunSnapshot } from '../../contracts/run/run.js';
import { parseDbosWorkflowStatus } from '../../validation/dbos-workflow-status.validator.js';
import {
  parseRunCommandDecision,
  parseUnknownResolutionDirective,
} from '../../validation/run-command-workflow.validator.js';
import { consensusParticipantWorkflowName } from '../consensus/consensus-names.js';
import {
  isNodeAttemptOutcomeStepName,
  isRunCommandDecisionStepName,
  isUnknownOutcomeResolutionStepName,
  unknownOutcomeResolutionAttemptId,
  nodeAttemptStepIdentity,
  parallelBranchWorkflowName,
  mapItemWorkflowName,
  repeatIterationWorkflowName,
  runCommandDecisionCommandId,
  runExecutionWorkflowName,
} from '../dbos-names.js';
import { runWorkflowId } from '../workflow-id.js';
import { loadAllWorkflowSteps, type DbosStepRecord } from './dbos-step-pages.js';
import { mapRunAttempt } from './map-run-attempt.js';
import { mapRunCommandDecision } from './map-run-command-decision.js';
import {
  buildObservablePlan,
  type ObservablePlan,
  type ObservableScopeCandidate,
} from './observable-plan.js';
import { RunConsensusProjector } from './run-consensus-observation-projector.js';
import { RunGateProjector } from './run-gate-projection.js';
import { RunMapObservationProjector } from './run-map-observation-projector.js';
import { RunParallelObservationProjector } from './run-parallel-observation-projector.js';
import { RunScopeObservationProjector } from './run-scope-observation-projector.js';
import { scopeCandidateFromStatus } from './scope-candidate-from-status.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

const introducedScopeWorkflow = (
  step: DbosStepRecord,
  introduced: ReadonlySet<string>,
): string | undefined => {
  if (step.childWorkflowID === null) {
    return undefined;
  }
  if (
    [
      runExecutionWorkflowName,
      parallelBranchWorkflowName,
      mapItemWorkflowName,
      repeatIterationWorkflowName,
      consensusParticipantWorkflowName,
    ].includes(step.name)
  ) {
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
  private readonly scopeProjection: RunScopeObservationProjector;
  private readonly nodeInstances: RunNodeInstance[] = [];
  private readonly attempts: RunAttempt[] = [];
  private readonly commands: RunCommandDetails[] = [];
  private readonly parallel: RunParallelObservationProjector;
  private readonly maps: RunMapObservationProjector;
  private readonly gates: RunGateProjector;
  private readonly consensuses: RunConsensusProjector;
  private readonly nodeIndexes = new Map<string, number>();
  private readonly includedAttempts = new Set<string>();
  private readonly visitedWorkflows = new Set<string>();
  private readonly activeWorkflows = new Set<string>();

  constructor(run: RunSnapshot) {
    this.run = run;
    this.plan = buildObservablePlan(run.executionPlan, run.id);
    const authoritativeTerminal = run.status !== 'pending' && run.status !== 'running';
    this.parallel = new RunParallelObservationProjector(this.plan, authoritativeTerminal);
    this.maps = new RunMapObservationProjector(this.plan, authoritativeTerminal);
    this.scopeProjection = new RunScopeObservationProjector(this.plan);
    this.gates = new RunGateProjector(this.plan);
    this.consensuses = new RunConsensusProjector(this.plan);
  }

  async load(): Promise<RunDetails> {
    const wrapperSteps = await loadAllWorkflowSteps(runWorkflowId(this.run.id));
    this.includeCommandDecisions(wrapperSteps);
    await this.visitIntroducedScopes(wrapperSteps);
    this.parallel.finish();
    this.maps.finish();
    return {
      run: this.run,
      scopes: this.scopeProjection.scopes,
      nodeInstances: this.nodeInstances,
      attempts: this.attempts,
      commands: this.commands,
      gates: this.gates.finish(this.commands),
      consensuses: this.consensuses.finish(),
      parallelJoins: this.parallel.observations,
      skippedParallelBranches: this.parallel.skippedBranches,
      mapExecutions: this.maps.observations,
      skippedMapItems: this.maps.skippedItems,
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
      const candidate = scopeCandidateFromStatus(status, this.run.id, this.plan);
      this.scopeProjection.includeDurable(status, candidate);
      this.maps.includeScopeStatus(status, candidate);
      this.consensuses.includeScopeStatus(status, candidate);

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
      const childWorkflowId = introducedScopeWorkflow(step, introduced);
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
    this.parallel.includeScopeSteps(steps, candidate);
    this.maps.includeScopeSteps(steps, candidate);
    this.gates.includeScopeSteps(steps, candidate);
    this.consensuses.includeScopeSteps(steps, candidate);
    await steps.reduce<Promise<void>>(async (previous, step) => {
      await previous;
      if (isNodeAttemptOutcomeStepName(step.name)) {
        this.includeAttempt(step, candidate);
      }
      if (isUnknownOutcomeResolutionStepName(step.name)) {
        this.includeUnknownOutcomeResolution(step);
      }
      const childWorkflowId = introducedScopeWorkflow(step, introduced);
      if (childWorkflowId !== undefined) {
        introduced.add(childWorkflowId);
        await this.visitWorkflow(childWorkflowId);
      }
    }, Promise.resolve());
  }

  private includeCommandDecisions(steps: readonly DbosStepRecord[]): void {
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
    const attemptId = unknownOutcomeResolutionAttemptId(step.name);
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

  private includeAttempt(step: DbosStepRecord, physicalScope: DurableScopeCandidate): void {
    const stepIdentity = nodeAttemptStepIdentity(step.name);
    const candidate = this.plan.nodesByDisplayPath.get(stepIdentity.displayPath);
    if (candidate?.physicalScopeId !== physicalScope.id) {
      throw new Error('DBOS node step is not present in its admitted scope.');
    }
    const attempt = mapRunAttempt(step, candidate, this.run.id, stepIdentity.attemptOrdinal, true);
    if (attempt === undefined) {
      return;
    }
    this.scopeProjection.includeForNode(candidate);
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
}

export const loadRunDetails = (run: RunSnapshot): Promise<RunDetails> =>
  new RunDetailsLoader(run).load();
