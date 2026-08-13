import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RecoveryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { ExecuteNodeEffect } from '../../pipeline/interpreter/interpreter-context.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { NodeEffectDecisionStepV2 } from './node-effect-decision-step-v2.js';
import { NodeEffectIntentStep } from './node-effect-intent-step.js';
import { NodeReconciliationStep } from './node-reconciliation-step.js';
import { isDbosStepTimeout } from './step-timeout.js';

export class NodeExecutionStepV2 {
  private readonly decision: NodeEffectDecisionStepV2;
  private readonly intent = new NodeEffectIntentStep();
  private readonly reconciliation: NodeReconciliationStep;

  constructor(executor: RunExecutorProvider, cancellation: ScopeCancellationRegistry) {
    this.decision = new NodeEffectDecisionStepV2(executor, cancellation);
    this.reconciliation = new NodeReconciliationStep(executor);
  }

  readonly execute: ExecuteNodeEffect = async (
    request: RunExecutorRequest,
    timeoutMs: number,
    recovery: RecoveryPolicy,
    nextReconciliationRound: number,
  ) => {
    return this.executeWithRecoveryFence(
      request,
      timeoutMs,
      recovery,
      nextReconciliationRound,
      async () => undefined,
    );
  };

  async executeWithRecoveryFence(
    request: RunExecutorRequest,
    timeoutMs: number,
    recovery: RecoveryPolicy,
    nextReconciliationRound: number,
    beforeRecovery: () => Promise<void>,
  ): ReturnType<ExecuteNodeEffect> {
    try {
      const intent = await this.intent.checkpoint(request);
      const decision = await this.decision.decide(intent, timeoutMs);
      if (decision.kind === 'runNodeExecution') {
        return { kind: 'effectResult', execution: decision, nextReconciliationRound };
      }
      if (decision.kind === 'runNodeCancelled') {
        return { kind: 'cancelled' };
      }
      await beforeRecovery();
      return this.reconcile(request, recovery, nextReconciliationRound);
    } catch (error) {
      if (isDbosStepTimeout(error)) {
        return { kind: 'timedOut' };
      }
      throw error;
    }
  }

  private async reconcile(
    request: RunExecutorRequest,
    recovery: RecoveryPolicy,
    reconciliationRound: number,
  ): ReturnType<ExecuteNodeEffect> {
    if (recovery.reconciliation === 'unsupported') {
      await this.reconciliation.checkpointUnknown(request, reconciliationRound);
      return { kind: 'outcomeUnknown', reconciliationRound };
    }
    if (reconciliationRound > recovery.maximumAttempts) {
      await this.reconciliation.checkpointUnknown(request, recovery.maximumAttempts);
      return { kind: 'recoveryExhausted', reconciliationRound: recovery.maximumAttempts };
    }

    const result = await this.reconciliation.reconcile(
      request,
      reconciliationRound,
      recovery.timeoutMs,
    );
    if (result.kind === 'reconciliationFailed') {
      return reconciliationRound < recovery.maximumAttempts
        ? this.reconcile(request, recovery, reconciliationRound + 1)
        : this.exhausted(request, reconciliationRound);
    }
    switch (result.result.kind) {
      case 'effectCompleted':
        return {
          kind: 'effectResult',
          execution: { kind: 'runNodeExecution', request, result: result.result.result },
          nextReconciliationRound: reconciliationRound + 1,
        };
      case 'effectFailed':
        return {
          kind: 'effectResult',
          execution: {
            kind: 'runNodeExecution',
            request,
            result: { kind: 'failed', error: result.result.error },
          },
          nextReconciliationRound: reconciliationRound + 1,
        };
      case 'effectNotFound':
        return { kind: 'effectNotFound', nextReconciliationRound: reconciliationRound + 1 };
      case 'outcomeUnknown':
        return { kind: 'outcomeUnknown', reconciliationRound };
    }
    result.result satisfies never;
    throw new Error('Reconciliation result is unsupported.');
  }

  private async exhausted(
    request: RunExecutorRequest,
    reconciliationRound: number,
  ): ReturnType<ExecuteNodeEffect> {
    await this.reconciliation.checkpointUnknown(request, reconciliationRound);
    return { kind: 'recoveryExhausted', reconciliationRound };
  }
}
