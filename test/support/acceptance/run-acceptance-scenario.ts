import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import { vi } from 'vitest';

import { createRunManager, RunManagerError } from '../../../src/index.js';
import type {
  ExecutionPlan,
  JsonValue,
  RunEvent,
  RunManager,
  RunStatus,
} from '../../../src/index.js';
import { advanceLogicalTime } from '../../dsl/scenario-time.js';
import type { RunScenario, ScenarioStep } from '../../dsl/scenario.js';
import { ControlledRunExecutor } from '../executor/controlled-run-executor.js';
import { runEffectRecoveryScenario } from '../process/run-effect-recovery-scenario.js';
import { runParallelRecoveryScenario } from '../process/run-parallel-recovery-scenario.js';
import { runRetryRecoveryScenario } from '../process/run-retry-recovery-scenario.js';
import { runSubscriptionRecoveryScenario } from '../process/run-subscription-recovery-scenario.js';
import { testDatabaseUrl } from '../test-environment.js';
import { RunCommandAcceptance } from './run-command-acceptance.js';
import { RunEventExpectations } from './run-event-expectations.js';
import { RunObservationAssertions } from './run-observation-assertions.js';

const terminal = (status: RunStatus): boolean => status !== 'pending' && status !== 'running';

class AcceptanceScenarioRunner {
  private readonly executor = new ControlledRunExecutor();
  private readonly runId = `acceptance-${randomUUID()}`;
  private readonly executorSideInputFailures = new Set<string>();
  private readonly eventExpectations = new RunEventExpectations(this.runId);
  private manager: RunManager;
  private observation: RunObservationAssertions;
  private eventIterator: AsyncIterator<RunEvent> | undefined;
  private logicalTimeMs = 0;
  private startError: Error | undefined;
  private subscriptionError: Error | undefined;
  private readonly runCommands: RunCommandAcceptance;

  constructor() {
    this.manager = this.createManager();
    this.runCommands = new RunCommandAcceptance(() => this.manager, this.executor, this.runId);
    this.observation = new RunObservationAssertions(
      this.manager,
      this.runId,
      this.eventExpectations,
    );
  }

  async run(scenario: RunScenario): Promise<void> {
    await this.manager.start();
    let scenarioError: unknown;
    try {
      await this.executeSteps(scenario.steps, 0, scenario.plan);
    } catch (error) {
      scenarioError = error;
    }
    try {
      await this.eventIterator?.return?.();
    } catch (error) {
      scenarioError ??= error;
    }
    try {
      await this.manager.stop();
    } catch (error) {
      if (scenarioError === undefined) {
        scenarioError = error;
      }
    }
    if (scenarioError !== undefined) {
      throw scenarioError;
    }
  }

  private async executeSteps(
    steps: readonly ScenarioStep[],
    index: number,
    plan: ExecutionPlan,
  ): Promise<void> {
    const step = steps[index];
    if (step === undefined) {
      return;
    }

    await this.executeStep(step, plan);
    const nextStep = steps[index + 1];
    if (
      step.kind === 'startRun' &&
      this.startError !== undefined &&
      nextStep?.kind !== 'expectPlanRejected'
    ) {
      throw this.startError;
    }
    await this.executeSteps(steps, index + 1, plan);
  }

  private async executeStep(step: ScenarioStep, plan: ExecutionPlan): Promise<void> {
    switch (step.kind) {
      case 'startRun':
        await this.startRun(plan, step.input, step.planSchemaVersionOverride);
        return;
      case 'expectNodeExecutions':
        await Promise.all(step.paths.map((path) => this.executor.expectStarted(path)));
        return;
      case 'expectAgentExecution':
        await this.executor.expectAgentExecution(step.path, step.roleId);
        return;
      case 'expectVersionedScriptExecution':
        await this.executor.expectVersionedScriptExecution(step.path, step.scriptId, step.revision);
        return;
      case 'expectNodeInput':
        await this.executor.expectInput(step.path, step.value);
        return;
      case 'completeNode':
        await this.executor.complete(
          step.path,
          {
            kind: 'completed',
            outcome: step.outcome,
            ...(step.output === undefined ? {} : { output: step.output }),
          },
          step.attempt,
        );
        return;
      case 'failNode':
        await this.executor.fail(step.path, step.errorCode, step.attempt);
        return;
      case 'failInputResolution':
        await this.failInputResolution(plan, step.path, step.errorCode);
        return;
      case 'expectNoNodeExecution':
        if (this.executorSideInputFailures.has(step.path)) {
          this.executor.expectNoExternalEffect(step.path);
        } else {
          this.executor.expectNotDispatched(step.path);
        }
        return;
      case 'expectRunStatus':
        await this.expectRunStatus(step.status);
        return;
      case 'expectOutputValue':
        await this.observation.expectOutputValue(step.path, step.outputKey, step.value);
        return;
      case 'expectJsonOutput':
        await this.observation.expectJsonOutput(
          step.path,
          step.outputKey,
          step.pointer,
          step.value,
        );
        return;
      case 'expectEvent':
        await this.expectEvent(step.event, plan);
        return;
      case 'resumeSubscription': {
        await this.eventIterator?.return?.();
        try {
          const subscription = this.manager.subscribeRunEvents(this.runId, {
            after: this.eventExpectations.cursor(step.afterCapturedCursor),
          });
          this.eventIterator = subscription[Symbol.asyncIterator]();
        } catch (error) {
          this.subscriptionError = error instanceof Error ? error : new Error(String(error));
          this.eventIterator = undefined;
        }
        return;
      }
      case 'captureCursorFromAnotherRun':
        await this.captureCursorFromAnotherRun(step.captureAs, plan);
        return;
      case 'expectSubscriptionError':
        await this.expectSubscriptionError(step.errorCode);
        return;
      case 'expectCursorOrder':
        await this.observation.expectCursorOrder(step.cursors);
        return;
      case 'expectMaximumActiveExecutions':
        await this.executor.expectMaximumActiveExecutions(step.count);
        return;
      case 'expectExecutionCount':
        await this.executor.expectExecutionCount(step.path, step.count);
        return;
      case 'expectRunDetails':
        await this.observation.expectRunDetails(step);
        return;
      case 'expectSecretAbsent':
        await this.observation.expectSecretAbsent(step.value);
        return;
      case 'expectSecretResolved':
        this.executor.expectResolvedSecret(step.value);
        return;
      case 'expectPlanRejected':
        assert(this.startError instanceof RunManagerError);
        assert.equal(this.startError.code, step.errorCode);
        return;
      case 'advanceTime':
        await this.advanceTime(step.durationMs);
        return;
      case 'crashManager':
        await this.crashManager();
        return;
      case 'restartManager':
        await this.restartManager();
        return;
      case 'cancelRun':
        await this.runCommands.cancel(step.actorId);
        return;
      case 'resolveUnknownOutcome':
        await this.runCommands.resolve(step);
        return;
      case 'expectCommandResult':
        this.runCommands.expectResult(step.result);
        return;
      case 'captureAttemptId':
        await this.runCommands.captureAttemptId(step.path, step.captureAs);
        return;
      case 'expectExecutorAborted':
        await this.executor.expectAborted(step.path);
        return;
      case 'ignoreExecutorAbort':
        this.executor.ignoreAbort(step.path);
        return;
      case 'reconcileNode':
        await this.runCommands.reconcile(step);
        return;
      case 'expectNoDuplicateExecution':
        await this.executor.expectExecutionCount(step.path, 1);
        return;
      case 'captureRunState':
        await this.runCommands.captureRunState(step.captureAs);
        return;
      case 'expectRunStateUnchanged':
        await this.runCommands.expectRunStateUnchanged(step.capture);
        return;
      case 'expectResolutionDetails':
        await this.runCommands.expectResolutionDetails(step);
        return;
      case 'expectScopeStatuses':
        await this.runCommands.expectScopeStatuses(step.paths, step.status);
        return;
      case 'expectNoActiveDurableScopes':
        await this.runCommands.expectNoActiveDurableScopes();
        return;
      case 'expectDistinctCommandIds':
        this.runCommands.expectDistinctCommandIds(step.captures);
        return;
      case 'answerHumanGate':
      case 'completeConsensusParticipant':
      case 'expectHumanGateWaiting':
      case 'expectIteration':
        throw new Error(`Scenario step ${step.kind} is not implemented.`);
    }

    step satisfies never;
  }

  private createManager(): RunManager {
    return createRunManager({
      database: { url: testDatabaseUrl() },
      executor: this.executor,
    });
  }

  private async advanceTime(durationMs: number): Promise<void> {
    this.logicalTimeMs = advanceLogicalTime(this.logicalTimeMs, durationMs);
    await this.waitForElapsedTime(performance.now(), durationMs);
  }

  private async waitForElapsedTime(startedAt: number, durationMs: number): Promise<void> {
    const remainingMs = durationMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      return;
    }
    await wait(remainingMs);
    await this.waitForElapsedTime(startedAt, durationMs);
  }

  private async crashManager(): Promise<void> {
    await this.eventIterator?.return?.();
    this.eventIterator = undefined;
    await this.manager.stop();
  }

  private async restartManager(): Promise<void> {
    this.manager = this.createManager();
    this.observation = new RunObservationAssertions(
      this.manager,
      this.runId,
      this.eventExpectations,
    );
    await this.manager.start();
  }

  private async startRun(
    plan: ExecutionPlan,
    input: JsonValue,
    schemaVersionOverride: number | undefined,
  ): Promise<void> {
    try {
      const executionPlan = structuredClone(plan);
      if (schemaVersionOverride !== undefined) {
        Object.defineProperty(executionPlan, 'schemaVersion', {
          enumerable: true,
          value: schemaVersionOverride,
        });
      }
      await this.manager.startRun({ runId: this.runId, executionPlan, input });
    } catch (error) {
      this.startError = error instanceof Error ? error : new Error(String(error));
    }
  }

  private async failInputResolution(
    plan: ExecutionPlan,
    path: string,
    errorCode: string,
  ): Promise<void> {
    if (errorCode === 'secret_not_found' || errorCode === 'entity_version_not_found') {
      this.executorSideInputFailures.add(path);
      await this.executor.failInputResolution(path, errorCode);
    }

    const events = await this.observation.eventsAfterTerminal();
    this.eventExpectations.expectInputResolutionFailure(events, plan, path, errorCode);
  }

  private async expectRunStatus(status: RunStatus): Promise<void> {
    await vi.waitFor(
      async () => {
        assert.equal((await this.manager.getRun(this.runId))?.status, status);
      },
      { timeout: 10_000 },
    );
  }

  private async expectEvent(
    expected: Extract<ScenarioStep, { readonly kind: 'expectEvent' }>['event'],
    plan: ExecutionPlan,
  ): Promise<void> {
    this.eventIterator ??= this.manager.subscribeRunEvents(this.runId)[Symbol.asyncIterator]();
    const next = await this.eventIterator.next();
    assert(!next.done, `Run stream ended before ${expected.type}.`);
    if (this.eventExpectations.captureIfExpected(next.value, plan, expected)) {
      return;
    }
    await this.expectEvent(expected, plan);
  }

  private async captureCursorFromAnotherRun(name: string, plan: ExecutionPlan): Promise<void> {
    const otherRunId = `acceptance-${randomUUID()}`;
    await this.manager.startRun({ runId: otherRunId, executionPlan: plan, input: null });
    await vi.waitFor(async () => {
      const run = await this.manager.getRun(otherRunId);
      assert(run !== undefined && terminal(run.status));
    });
    const event = (await this.manager.getRunEvents(otherRunId, { limit: 100 })).items.at(-1);
    assert(event !== undefined);
    this.eventExpectations.captureCursor(name, event.cursor);
  }

  private async expectSubscriptionError(errorCode: string): Promise<void> {
    const error =
      this.subscriptionError ??
      (await this.eventIterator?.next().catch((caught: unknown) => caught));
    assert(error instanceof RunManagerError);
    assert.equal(error.code, errorCode);
    this.subscriptionError = undefined;
  }
}

export const runAcceptanceScenario = async (scenario: RunScenario): Promise<void> => {
  if (['rr-011', 'rr-012', 'rr-013', 'rr-014', 'rr-015', 'rr-016'].includes(scenario.intentId)) {
    await runEffectRecoveryScenario(scenario);
    return;
  }
  if (scenario.intentId === 'rr-010') {
    await runRetryRecoveryScenario(scenario);
    return;
  }
  if (scenario.intentId === 'rr-084') {
    await runSubscriptionRecoveryScenario(scenario);
    return;
  }
  if (scenario.intentId === 'rr-078') {
    await runParallelRecoveryScenario(scenario);
    return;
  }
  await new AcceptanceScenarioRunner().run(scenario);
};
