import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createRunManager } from '../../../src/index.js';
import type { RunEvent, RunEventCursor, RunManager, RunStatus } from '../../../src/index.js';
import type { RunScenario, ScenarioStep } from '../../dsl/scenario.js';
import { RunEventExpectations } from '../acceptance/run-event-expectations.js';
import { ControlledRunExecutor } from '../executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../test-environment.js';
import { forkTestDbosProcess } from './fork-test-dbos-process.js';
import { testProcessApplicationVersion } from './test-process-application-version.js';

interface ObserverMessage {
  readonly kind: 'error' | 'event' | 'ready' | 'stopped';
  readonly cursor?: string;
  readonly event?: RunEvent;
  readonly message?: string;
  readonly type?: string;
}

class ObserverProcess {
  private readonly child;
  private readonly messages: ObserverMessage[] = [];
  private readonly errors: string[] = [];
  private nextMessageIndex = 0;

  constructor(runId: string, after?: RunEventCursor) {
    const worker = fileURLToPath(new URL('./run-observer-process-worker.ts', import.meta.url));
    this.child = forkTestDbosProcess(worker, {
      applicationVersion: testProcessApplicationVersion('run-observer', runId),
      env: {
        REVO_RUN_TEST_DATABASE_URL: testDatabaseUrl(),
        REVO_RUN_TEST_RUN_ID: runId,
        ...(after === undefined ? {} : { REVO_RUN_TEST_AFTER_CURSOR: after }),
      },
    });
    this.child.on('message', (message: ObserverMessage) => this.messages.push(message));
    this.child.stderr?.on('data', (chunk: Buffer) => this.errors.push(chunk.toString()));
  }

  async expectNext(expected: Partial<ObserverMessage>): Promise<ObserverMessage> {
    const deadline = Date.now() + 10_000;
    const poll = async (): Promise<ObserverMessage> => {
      const next = this.messages[this.nextMessageIndex];
      if (next !== undefined) {
        this.nextMessageIndex += 1;
        if (
          (expected.kind === undefined || next.kind === expected.kind) &&
          (expected.type === undefined || next.type === expected.type)
        ) {
          return next;
        }
        throw new Error(
          `Observer emitted ${JSON.stringify(next)} before ${JSON.stringify(expected)}.`,
        );
      }
      if (Date.now() >= deadline || this.child.exitCode !== null) {
        throw new Error(
          `Observer did not emit ${JSON.stringify(expected)}. Messages: ${JSON.stringify(this.messages)}. ${this.errors.join('')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return poll();
    };
    return poll();
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.child.kill('SIGKILL');
    await new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
  }
}

export const runSubscriptionRecoveryScenario = async (scenario: RunScenario): Promise<void> => {
  await new SubscriptionRecoveryScenarioRunner(scenario).run();
};

const terminal = (status: RunStatus): boolean => status !== 'pending' && status !== 'running';

class SubscriptionRecoveryScenarioRunner {
  private readonly executor = new ControlledRunExecutor();
  private readonly manager: RunManager;
  private readonly runId = `acceptance-${randomUUID()}`;
  private readonly scenario: RunScenario;
  private readonly events: RunEventExpectations;
  private observer: ObserverProcess | undefined;
  private observerCrashed = false;
  private observerRestarted = false;
  private resumedAfter: RunEventCursor | undefined;

  constructor(scenario: RunScenario) {
    this.scenario = scenario;
    this.events = new RunEventExpectations(this.runId);
    this.manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: this.executor,
    });
  }

  async run(): Promise<void> {
    await this.manager.start();
    try {
      await this.executeSteps(this.scenario.steps, 0);
      const observer = this.observer;
      assert(observer !== undefined, 'Restarted observer must stop normally.');
      await observer.expectNext({ kind: 'stopped' });
      this.observer = undefined;
    } finally {
      await this.observer?.kill();
      await this.manager.stop();
    }
  }

  private async executeSteps(steps: readonly ScenarioStep[], index: number): Promise<void> {
    const step = steps[index];
    if (step === undefined) {
      return;
    }
    await this.execute(step);
    await this.executeSteps(steps, index + 1);
  }

  private async execute(step: ScenarioStep): Promise<void> {
    switch (step.kind) {
      case 'startRun':
        await this.startRun(step);
        return;
      case 'expectEvent':
        await this.expectEvent(step);
        return;
      case 'crashManager':
        assert.equal(step.moment, 'whileWaiting');
        assert(this.observer !== undefined);
        await this.observer.kill();
        this.observer = undefined;
        this.observerCrashed = true;
        return;
      case 'restartManager':
        assert(this.observerCrashed, 'Observer manager must crash before restart.');
        this.observerRestarted = true;
        return;
      case 'resumeSubscription':
        assert(this.observerRestarted, 'Observer manager must restart before resuming.');
        this.resumedAfter = this.events.cursor(step.afterCapturedCursor);
        await this.startObserver(this.resumedAfter);
        return;
      case 'completeNode':
        await this.executor.complete(step.path, {
          kind: 'completed',
          outcome: step.outcome,
          ...(step.output === undefined ? {} : { output: step.output }),
        });
        return;
      case 'expectRunStatus':
        await this.expectRunStatus(step.status);
        return;
      case 'answerHumanGate':
      case 'cancelRun':
      case 'captureAttemptId':
      case 'captureRunState':
      case 'captureCursorFromAnotherRun':
      case 'completeConsensusParticipant':
      case 'expectAgentExecution':
      case 'expectCommandResult':
      case 'expectDistinctCommandIds':
      case 'expectExecutorAborted':
      case 'expectCursorOrder':
      case 'expectExecutionCount':
      case 'expectHumanGateWaiting':
      case 'expectIteration':
      case 'expectJsonOutput':
      case 'expectMaximumActiveExecutions':
      case 'expectNodeExecutions':
      case 'expectNodeInput':
      case 'expectNoDuplicateExecution':
      case 'expectNoActiveDurableScopes':
      case 'expectNoNodeExecution':
      case 'expectOutputValue':
      case 'expectPlanRejected':
      case 'expectRunDetails':
      case 'expectRunStateUnchanged':
      case 'expectResolutionDetails':
      case 'expectScopeStatuses':
      case 'expectSecretAbsent':
      case 'expectSecretResolved':
      case 'expectSubscriptionError':
      case 'expectVersionedScriptExecution':
      case 'failInputResolution':
      case 'failNode':
      case 'ignoreExecutorAbort':
      case 'reconcileNode':
      case 'resolveUnknownOutcome':
      case 'advanceTime':
        throw new Error(`Subscription recovery step ${step.kind} is not implemented.`);
    }

    step satisfies never;
  }

  private async startRun(
    step: Extract<ScenarioStep, { readonly kind: 'startRun' }>,
  ): Promise<void> {
    const executionPlan = structuredClone(this.scenario.plan);
    if (step.planSchemaVersionOverride !== undefined) {
      Object.defineProperty(executionPlan, 'schemaVersion', {
        enumerable: true,
        value: step.planSchemaVersionOverride,
      });
    }
    await this.manager.startRun({ runId: this.runId, executionPlan, input: step.input });
  }

  private async expectEvent(
    step: Extract<ScenarioStep, { readonly kind: 'expectEvent' }>,
  ): Promise<void> {
    if (this.observer === undefined) {
      await this.startObserver();
    }
    const observer = this.observer;
    assert(observer !== undefined);
    const message = await observer.expectNext({ kind: 'event', type: step.event.type });
    assert(message.event !== undefined);
    if (this.resumedAfter !== undefined) {
      assert.notEqual(message.event.cursor, this.resumedAfter, 'Captured cursor was replayed.');
      assert.notEqual(
        message.event.type,
        'nodeExecution.started',
        'Captured nodeExecution.started event was replayed.',
      );
    }
    assert(
      this.events.captureIfExpected(message.event, this.scenario.plan, step.event),
      `Observed ${message.event.type} does not match the declared DSL event.`,
    );
  }

  private async startObserver(after?: RunEventCursor): Promise<void> {
    assert(this.observer === undefined);
    this.observer = new ObserverProcess(this.runId, after);
    await this.observer.expectNext({ kind: 'ready' });
  }

  private async expectRunStatus(expected: RunStatus): Promise<void> {
    if (terminal(expected)) {
      const run = await this.manager.waitForTerminal(this.runId, { timeoutMs: 5_000 });
      assert.equal(run.status, expected);
      return;
    }
    const run = await this.manager.getRun(this.runId);
    assert.equal(run?.status, expected);
  }
}
