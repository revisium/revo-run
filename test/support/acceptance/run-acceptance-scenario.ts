import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { vi } from 'vitest';

import { createRunManager, RunManagerError } from '../../../src/index.js';
import type {
  ExecutionPlan,
  JsonValue,
  RunDetails,
  RunEvent,
  RunManager,
  RunStatus,
} from '../../../src/index.js';
import type { RunScenario, ScenarioStep } from '../../dsl/scenario.js';
import { ControlledRunExecutor } from '../executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../test-environment.js';
import { RunEventExpectations } from './run-event-expectations.js';

const terminal = (status: RunStatus): boolean => status !== 'pending' && status !== 'running';

class AcceptanceScenarioRunner {
  private readonly executor = new ControlledRunExecutor();
  private readonly manager: RunManager;
  private readonly runId = `acceptance-${randomUUID()}`;
  private readonly executorSideInputFailures = new Set<string>();
  private readonly eventExpectations = new RunEventExpectations(this.runId);
  private startError: Error | undefined;

  constructor() {
    this.manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: this.executor,
    });
  }

  async run(scenario: RunScenario): Promise<void> {
    await this.manager.start();
    try {
      await this.executeSteps(scenario.steps, 0, scenario.plan);
    } finally {
      await this.manager.stop();
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
        await this.executor.complete(step.path, {
          kind: 'completed',
          outcome: step.outcome,
          ...(step.output === undefined ? {} : { output: step.output }),
        });
        return;
      case 'failNode':
        await this.executor.fail(step.path, step.errorCode);
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
        await this.expectOutputValue(step.path, step.outputKey, step.value);
        return;
      case 'expectJsonOutput':
        await this.expectJsonOutput(step.path, step.outputKey, step.pointer, step.value);
        return;
      case 'expectEvent':
        await this.expectEvent(step.event, plan);
        return;
      case 'expectCursorOrder':
        await this.expectCursorOrder(step.cursors);
        return;
      case 'expectMaximumActiveExecutions':
        await this.executor.expectMaximumActiveExecutions(step.count);
        return;
      case 'expectExecutionCount':
        await this.executor.expectExecutionCount(step.path, step.count);
        return;
      case 'expectRunDetails':
        await this.expectRunDetails(step.nodePaths);
        return;
      case 'expectSecretAbsent':
        await this.expectSecretAbsent(step.value);
        return;
      case 'expectSecretResolved':
        this.executor.expectResolvedSecret(step.value);
        return;
      case 'expectPlanRejected':
        assert(this.startError instanceof RunManagerError);
        assert.equal(this.startError.code, step.errorCode);
        return;
      case 'answerHumanGate':
      case 'cancelRun':
      case 'completeConsensusParticipant':
      case 'crashManager':
      case 'expectCommandResult':
      case 'expectHumanGateWaiting':
      case 'expectIteration':
      case 'expectNoDuplicateExecution':
      case 'expectSubscriptionError':
      case 'reconcileNode':
      case 'resolveUnknownOutcome':
      case 'restartManager':
      case 'resumeSubscription':
      case 'advanceTime':
        throw new Error(`Scenario step ${step.kind} is not implemented.`);
    }

    step satisfies never;
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

    const events = await this.eventsAfterTerminal();
    this.eventExpectations.expectInputResolutionFailure(events, plan, path, errorCode);
  }

  private async expectRunStatus(status: RunStatus): Promise<void> {
    await vi.waitFor(
      async () => {
        assert.equal((await this.manager.getRun(this.runId))?.status, status);
      },
      { timeout: 5_000 },
    );
  }

  private async expectOutputValue(path: string, key: string, value: unknown): Promise<void> {
    await vi.waitFor(async () => {
      const execution = (await this.details()).nodeExecutions.find(
        ({ request }) => request.displayPath === path,
      );
      assert(execution?.result.kind === 'completed');
      assert.deepStrictEqual(execution.result.output?.[key], value);
    });
  }

  private async expectJsonOutput(
    path: string,
    key: string,
    pointer: string | undefined,
    value: unknown,
  ): Promise<void> {
    await vi.waitFor(async () => {
      const execution = (await this.details()).nodeExecutions.find(
        ({ request }) => request.displayPath === path,
      );
      assert(execution?.result.kind === 'completed');
      const output = execution.result.output?.[key];
      assert(output?.kind === 'json');
      assert.equal(pointer, undefined);
      assert.deepStrictEqual(output.value, value);
    });
  }

  private async expectEvent(
    expected: Extract<ScenarioStep, { readonly kind: 'expectEvent' }>['event'],
    plan: ExecutionPlan,
  ): Promise<void> {
    const events = await this.eventsAfterTerminal();
    this.eventExpectations.expectEvent(events, plan, expected);
  }

  private async expectCursorOrder(captures: readonly string[]): Promise<void> {
    const events = await this.eventsAfterTerminal();
    this.eventExpectations.expectCursorOrder(events, captures);
  }

  private async expectRunDetails(nodePaths: readonly string[]): Promise<void> {
    await vi.waitFor(
      async () => {
        const actual = (await this.details()).nodeExecutions.map(
          ({ request }) => request.displayPath,
        );
        assert.deepStrictEqual(new Set(actual), new Set(nodePaths));
      },
      { timeout: 5_000 },
    );
  }

  private async expectSecretAbsent(value: string): Promise<void> {
    await this.waitForTerminal();
    const stored = JSON.stringify({
      run: await this.manager.getRun(this.runId),
      details: await this.manager.getRunDetails(this.runId),
      events: await this.collectEvents(),
    });
    assert(!stored.includes(value));
  }

  private async details(): Promise<RunDetails> {
    const details = await this.manager.getRunDetails(this.runId);
    if (details === undefined) {
      throw new Error(`Run ${this.runId} was not found.`);
    }
    return details;
  }

  private async eventsAfterTerminal(): Promise<readonly RunEvent[]> {
    await this.waitForTerminal();
    return this.collectEvents();
  }

  private async waitForTerminal(): Promise<void> {
    await vi.waitFor(
      async () => {
        const run = await this.manager.getRun(this.runId);
        assert(run !== undefined && terminal(run.status));
      },
      { timeout: 5_000 },
    );
  }

  private async collectEvents(): Promise<readonly RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const event of this.manager.subscribeRunEvents(this.runId)) {
      events.push(event);
    }
    return events;
  }
}

export const runAcceptanceScenario = async (scenario: RunScenario): Promise<void> => {
  await new AcceptanceScenarioRunner().run(scenario);
};
