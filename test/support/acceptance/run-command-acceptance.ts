import assert from 'node:assert/strict';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { vi } from 'vitest';

import { scopeWorkflowId } from '../../../src/dbos/workflow-id.js';
import { isActiveWorkflowStatus } from '../../../src/dbos/workflow-status.js';
import type { RunCommandReceipt, RunManager, RunScope } from '../../../src/index.js';
import type { ScenarioStep } from '../../dsl/scenario.js';
import type { ControlledRunExecutor } from '../executor/controlled-run-executor.js';

type ManagerAccessor = () => RunManager;

export class RunCommandAcceptance {
  private readonly manager: ManagerAccessor;
  private readonly executor: ControlledRunExecutor;
  private readonly runId: string;
  private result: RunCommandReceipt | undefined;
  private readonly commandIds = new Map<string, string>();
  private readonly attemptIds = new Map<string, string>();
  private readonly runStates = new Map<string, string>();

  constructor(manager: ManagerAccessor, executor: ControlledRunExecutor, runId: string) {
    this.manager = manager;
    this.executor = executor;
    this.runId = runId;
  }

  async cancel(actorId: string): Promise<void> {
    this.result = await this.manager().cancelRun({ runId: this.runId, actorId });
  }

  async resolve(
    step: Extract<ScenarioStep, { readonly kind: 'resolveUnknownOutcome' }>,
  ): Promise<void> {
    const attemptId = this.attemptIds.get(step.attemptCapture);
    assert(attemptId !== undefined, `Attempt capture ${step.attemptCapture} is missing.`);
    this.result = await this.manager().resolveUnknownOutcome({
      runId: this.runId,
      attemptId,
      actorId: step.actorId,
      resolution: step.resolution,
    });
  }

  expectResult(
    expected: Extract<ScenarioStep, { readonly kind: 'expectCommandResult' }>['result'],
  ): void {
    assert(this.result !== undefined, 'No run command result was captured.');
    assert.equal(this.result.status, expected.status);
    if (expected.status === 'rejected') {
      assert(this.result.status === 'rejected');
      assert.equal(this.result.reason, expected.reason);
    }
    if (expected.captureCommandIdAs !== undefined) {
      this.commandIds.set(expected.captureCommandIdAs, this.result.commandId);
    }
  }

  async captureAttemptId(path: string, captureAs: string): Promise<void> {
    await vi.waitFor(async () => {
      const details = await this.manager().getRunDetails(this.runId);
      const node = details?.nodeInstances.find(({ displayPath }) => displayPath === path);
      const attemptId = node?.attemptIds.at(-1);
      assert(attemptId !== undefined);
      this.attemptIds.set(captureAs, attemptId);
    });
  }

  async reconcile(step: Extract<ScenarioStep, { readonly kind: 'reconcileNode' }>): Promise<void> {
    switch (step.result) {
      case 'effectCompleted':
        await this.executor.reconcileNode(step.path, {
          kind: 'effectCompleted',
          result: {
            kind: 'completed',
            outcome: 'completed',
            ...(step.output === undefined ? {} : { output: step.output }),
          },
        });
        return;
      case 'effectFailed':
        await this.executor.reconcileNode(step.path, {
          kind: 'effectFailed',
          error: { code: 'effect_failed', message: 'Effect failed.' },
        });
        return;
      case 'effectNotFound':
        await this.executor.reconcileNode(step.path, { kind: 'effectNotFound' });
        return;
      case 'outcomeUnknown':
        await this.executor.reconcileNode(step.path, { kind: 'outcomeUnknown' });
        return;
      case 'reconciliationFailed':
        throw new Error('Acceptance executor cannot synthesize reconciliation transport failure.');
    }
  }

  async captureRunState(captureAs: string): Promise<void> {
    this.runStates.set(captureAs, await this.runState());
  }

  async expectRunStateUnchanged(capture: string): Promise<void> {
    assert.equal(await this.runState(), this.runStates.get(capture));
  }

  async expectResolutionDetails(
    expected: Extract<ScenarioStep, { readonly kind: 'expectResolutionDetails' }>,
  ): Promise<void> {
    const attemptId = this.attemptIds.get(expected.attemptCapture);
    assert(attemptId !== undefined);
    await vi.waitFor(async () => {
      const details = await this.manager().getRunDetails(this.runId);
      assert(details !== undefined);
      const attempt = details.attempts.find(({ id }) => id === attemptId);
      const node = details.nodeInstances.find(({ id }) => id === attempt?.nodeInstanceId);
      assert(attempt?.status === 'outcomeUnknown');
      assert.equal(node?.status, expected.nodeStatus);
      assert(
        details.commands.some(
          (command) =>
            command.commandKind === 'resolveUnknownOutcome' &&
            command.actorId === expected.actorId &&
            command.targetAttemptId === attemptId &&
            command.decision === 'accepted' &&
            command.resolution?.kind === expected.resolutionKind &&
            command.resolution.outcome === expected.outcome,
        ),
      );
    });
  }

  async expectScopeStatuses(paths: readonly string[], status: 'cancelled'): Promise<void> {
    await vi.waitFor(async () => {
      const details = await this.manager().getRunDetails(this.runId);
      assert(details !== undefined);
      for (const path of paths) {
        const scope: RunScope | undefined = details.scopes.find(
          ({ displayPath }) => displayPath === path,
        );
        assert(scope !== undefined && scope.kind !== 'inlineSubpipeline');
        assert.equal(scope.status, status);
      }
    });
  }

  async expectNoActiveDurableScopes(): Promise<void> {
    const details = await this.manager().getRunDetails(this.runId);
    assert(details !== undefined);
    await Promise.all(
      details.scopes
        .filter((scope) => scope.kind !== 'inlineSubpipeline')
        .map(async (scope) => {
          const status = await DBOS.getWorkflowStatus(scopeWorkflowId(scope.id));
          assert(status !== null && !isActiveWorkflowStatus(status.status));
        }),
    );
  }

  expectDistinctCommandIds(captures: readonly string[]): void {
    assert.equal(
      new Set(captures.map((capture) => this.commandIds.get(capture))).size,
      captures.length,
    );
  }

  private async runState(): Promise<string> {
    return JSON.stringify({
      run: await this.manager().getRun(this.runId),
      history: await this.manager().getRunEvents(this.runId, { limit: 100 }),
    });
  }
}
