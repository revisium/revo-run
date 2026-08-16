import type {
  RunCommandDetails,
  RunGate,
  RunGateResolution,
} from '../../contracts/run/run-details.js';
import { parseHumanGateResolutionDirective } from '../../validation/run-command-workflow.validator.js';
import {
  humanGateResolutionGateInstanceId,
  humanGateWaitingGateInstanceId,
  isHumanGateResolutionStepName,
  isHumanGateWaitingStepName,
} from '../human-gate-names.js';
import type { DbosStepRecord } from './dbos-step-pages.js';
import type { ObservablePlan, ObservableScopeCandidate } from './observable-plan.js';

type DurableScopeCandidate = Exclude<
  ObservableScopeCandidate,
  { readonly kind: 'inlineSubpipeline' }
>;

const gateResolution = (
  directive: ReturnType<typeof parseHumanGateResolutionDirective>,
): RunGateResolution => {
  switch (directive.kind) {
    case 'answered':
      return { kind: 'answered', answer: directive.answer };
    case 'conflict':
      return { kind: 'conflict' };
    case 'timedOut':
      return { kind: 'timedOut' };
    case 'cancel':
      return { kind: 'cancelled' };
    case 'fail':
      return { kind: 'failed' };
  }
  directive satisfies never;
  throw new Error('Human gate resolution directive is unsupported.');
};

/**
 * Owns durable projection of pending and resolved human gates from the two scope-workflow step
 * checkpoints (human-gate-waiting / human-gate-resolution), then attributes accepted answers from
 * the already-projected accepted answerGate command decisions. Neither the event stream nor
 * private DBOS SQL is read (decision D-12's read-side counterpart).
 */
export class RunGateProjector {
  private readonly gates = new Map<string, RunGate>();

  constructor(private readonly plan: ObservablePlan) {}

  includeScopeSteps(steps: readonly DbosStepRecord[], physicalScope: DurableScopeCandidate): void {
    for (const step of steps) {
      if (isHumanGateWaitingStepName(step.name)) {
        this.includeWaiting(step, physicalScope);
      }
      if (isHumanGateResolutionStepName(step.name)) {
        this.includeResolution(step);
      }
    }
  }

  finish(commands: readonly RunCommandDetails[]): readonly RunGate[] {
    for (const command of commands) {
      if (
        command.commandKind !== 'answerGate' ||
        command.decision !== 'accepted' ||
        command.gateInstanceId === undefined ||
        command.answer === undefined ||
        command.actorId === undefined
      ) {
        continue;
      }
      const gate =
        this.gates.get(command.gateInstanceId) ?? this.synthesizeFromPlan(command.gateInstanceId);
      if (gate === undefined) {
        continue;
      }
      this.gates.set(command.gateInstanceId, {
        ...gate,
        acceptedAnswers: [
          ...gate.acceptedAnswers,
          { actorId: command.actorId, answer: command.answer, commandId: command.commandId },
        ],
      });
    }
    return [...this.gates.values()].toSorted((left, right) =>
      left.displayPath.localeCompare(right.displayPath),
    );
  }

  private synthesizeFromPlan(gateInstanceId: string): RunGate | undefined {
    const candidate = this.plan.gatesByNodeInstanceId.get(gateInstanceId);
    if (candidate === undefined) {
      return undefined;
    }
    const synthesized: RunGate = {
      id: candidate.id,
      scopeId: candidate.scopeId,
      authoredNodeId: candidate.authoredNodeId,
      pipelineId: candidate.pipelineId,
      nodePath: candidate.nodePath,
      displayPath: candidate.displayPath,
      answers: candidate.answers,
      decision: candidate.decision,
      ...(candidate.eligibleGroup === undefined ? {} : { eligibleGroup: candidate.eligibleGroup }),
      acceptedAnswers: [],
      status: 'pending',
    };
    this.gates.set(gateInstanceId, synthesized);
    return synthesized;
  }

  private includeWaiting(step: DbosStepRecord, physicalScope: DurableScopeCandidate): void {
    if (step.error !== null) {
      throw new Error('Human gate waiting step failed.');
    }
    const gateInstanceId = humanGateWaitingGateInstanceId(step.name);
    if (step.output !== gateInstanceId) {
      throw new Error('Human gate waiting checkpoint identity is invalid.');
    }
    const candidate = this.plan.gatesByNodeInstanceId.get(gateInstanceId);
    if (candidate?.physicalScopeId !== physicalScope.id) {
      throw new Error('Human gate waiting checkpoint is not present in its admitted scope.');
    }
    if (this.gates.has(gateInstanceId)) {
      throw new Error('Human gate waiting checkpoint is duplicated.');
    }
    this.gates.set(gateInstanceId, {
      id: candidate.id,
      scopeId: candidate.scopeId,
      authoredNodeId: candidate.authoredNodeId,
      pipelineId: candidate.pipelineId,
      nodePath: candidate.nodePath,
      displayPath: candidate.displayPath,
      answers: candidate.answers,
      decision: candidate.decision,
      ...(candidate.eligibleGroup === undefined ? {} : { eligibleGroup: candidate.eligibleGroup }),
      ...(step.startedAtEpochMs === undefined ? {} : { openedAt: new Date(step.startedAtEpochMs) }),
      acceptedAnswers: [],
      status: 'pending',
    });
  }

  private includeResolution(step: DbosStepRecord): void {
    if (step.error !== null) {
      throw new Error('Human gate resolution step failed.');
    }
    const gateInstanceId = humanGateResolutionGateInstanceId(step.name);
    const gate = this.gates.get(gateInstanceId);
    if (gate?.status !== 'pending') {
      return;
    }
    const resolution = gateResolution(parseHumanGateResolutionDirective(step.output));
    this.gates.set(gateInstanceId, {
      ...gate,
      status: 'resolved',
      resolution,
      ...(step.completedAtEpochMs === undefined
        ? {}
        : { resolvedAt: new Date(step.completedAtEpochMs) }),
    });
  }
}
