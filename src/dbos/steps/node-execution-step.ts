import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RecoveryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { ExecuteNodeEffect } from '../../pipeline/interpreter/interpreter-context.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type {
  ProviderCallPermit,
  ProviderCallRegistry,
} from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { NodeEffectDecisionStep } from './node-effect-decision-step.js';
import { NodeEffectIntentStep } from './node-effect-intent-step.js';
import { NodeEffectSelectionStep } from './node-effect-selection-step.js';
import { NodeReconciliationStep } from './node-reconciliation-step.js';
import { isDbosStepTimeout } from './step-timeout.js';

export interface NodeExecutionCoordinator {
  readonly boundary: () => Promise<void>;
  readonly reserveExecution: (
    request: RunExecutorRequest,
    permitCommandId?: string,
  ) => Promise<boolean>;
  readonly executionStarted: (request: RunExecutorRequest) => Promise<void>;
}

type ProviderPermitAcquisition =
  | { readonly kind: 'acquired'; readonly permit: ProviderCallPermit }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timedOut' };

type ProviderDispatchPreparation = 'cancelled' | 'executionLimitExceeded' | 'ready';

export class NodeExecutionStep {
  private readonly decision: NodeEffectDecisionStep;
  private readonly intent = new NodeEffectIntentStep();
  private readonly selection = new NodeEffectSelectionStep();
  private readonly reconciliation: NodeReconciliationStep;

  constructor(
    executor: RunExecutorProvider,
    private readonly cancellation: ScopeCancellationRegistry,
    private readonly providerCalls: ProviderCallRegistry,
    private readonly coordinator: NodeExecutionCoordinator,
    private readonly maximumParallelism: number,
  ) {
    this.decision = new NodeEffectDecisionStep(executor);
    this.reconciliation = new NodeReconciliationStep(executor, cancellation);
  }

  readonly execute: ExecuteNodeEffect = async (
    request,
    timeoutMs,
    recovery,
    nextReconciliationRound,
    permitCommandId,
  ) => {
    const cancellationSignal = this.cancellation.signal(request.runId, request.scopeId);
    try {
      const intent = await this.intent.checkpoint(request);
      const selection = await this.selection.select(intent);
      if (selection.mode === 'execute') {
        return await this.executeProvider(
          request,
          timeoutMs,
          recovery,
          nextReconciliationRound,
          permitCommandId,
          cancellationSignal,
          selection.storedRecoveryGeneration,
        );
      }
      return await this.reconcile(
        request,
        recovery,
        nextReconciliationRound,
        permitCommandId,
        cancellationSignal,
        true,
      );
    } catch (error) {
      if (this.cancellation.isCancellation(error, cancellationSignal)) {
        await this.decision.cancelled(request, timeoutMs);
        return { kind: 'cancelled' };
      }
      if (isDbosStepTimeout(error)) {
        return { kind: 'timedOut' };
      }
      throw error;
    }
  };

  private async executeProvider(
    request: RunExecutorRequest,
    timeoutMs: number,
    recovery: RecoveryPolicy,
    nextReconciliationRound: number,
    permitCommandId: string | undefined,
    cancellationSignal: AbortSignal,
    storedRecoveryGeneration: number,
  ): ReturnType<ExecuteNodeEffect> {
    const permit = await this.acquirePermit(request, timeoutMs, cancellationSignal);
    if (permit.kind !== 'acquired') {
      return { kind: permit.kind };
    }
    const preparation = await this.prepareProviderDispatch(
      request,
      permitCommandId,
      permit.permit,
      cancellationSignal,
    );
    if (preparation !== 'ready') {
      return { kind: preparation };
    }
    const decision = await this.decision.execute(
      request,
      timeoutMs,
      cancellationSignal,
      storedRecoveryGeneration,
      permit.permit,
    );
    if (decision.kind === 'runNodeExecution') {
      return { kind: 'effectResult', execution: decision, nextReconciliationRound };
    }
    if (decision.kind === 'runNodeCancelled') {
      return { kind: 'cancelled' };
    }
    return this.reconcile(
      request,
      recovery,
      nextReconciliationRound,
      permitCommandId,
      cancellationSignal,
      false,
    );
  }

  private async reconcile(
    request: RunExecutorRequest,
    recovery: RecoveryPolicy,
    reconciliationRound: number,
    permitCommandId: string | undefined,
    cancellationSignal: AbortSignal,
    announceStarted: boolean,
  ): ReturnType<ExecuteNodeEffect> {
    if (recovery.reconciliation === 'unsupported') {
      await this.coordinator.boundary();
      if (!(await this.coordinator.reserveExecution(request, permitCommandId))) {
        return { kind: 'executionLimitExceeded' };
      }
      if (announceStarted) {
        await this.coordinator.executionStarted(request);
      }
      await this.reconciliation.checkpointUnknown(request, reconciliationRound);
      return { kind: 'outcomeUnknown', reconciliationRound };
    }
    if (reconciliationRound > recovery.maximumAttempts) {
      await this.reconciliation.checkpointUnknown(request, recovery.maximumAttempts);
      return { kind: 'recoveryExhausted', reconciliationRound: recovery.maximumAttempts };
    }

    const permit = await this.acquirePermit(request, recovery.timeoutMs, cancellationSignal);
    if (permit.kind !== 'acquired') {
      return { kind: permit.kind };
    }
    const preparation = await this.prepareProviderDispatch(
      request,
      permitCommandId,
      permit.permit,
      cancellationSignal,
      announceStarted,
    );
    if (preparation !== 'ready') {
      return { kind: preparation };
    }
    const result = await this.reconciliation.reconcile(
      request,
      reconciliationRound,
      recovery.timeoutMs,
      cancellationSignal,
      permit.permit,
    );
    if (result.kind === 'reconciliationFailed') {
      return reconciliationRound < recovery.maximumAttempts
        ? this.reconcile(
            request,
            recovery,
            reconciliationRound + 1,
            permitCommandId,
            cancellationSignal,
            false,
          )
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

  private async prepareProviderDispatch(
    request: RunExecutorRequest,
    permitCommandId: string | undefined,
    permit: ProviderCallPermit,
    cancellationSignal: AbortSignal,
    announceStarted = true,
  ): Promise<ProviderDispatchPreparation> {
    try {
      if (cancellationSignal.aborted) {
        permit.release();
        return 'cancelled';
      }
      await this.coordinator.boundary();
      if (cancellationSignal.aborted) {
        permit.release();
        return 'cancelled';
      }
      if (!(await this.coordinator.reserveExecution(request, permitCommandId))) {
        permit.release();
        return cancellationSignal.aborted ? 'cancelled' : 'executionLimitExceeded';
      }
      if (announceStarted) {
        await this.coordinator.executionStarted(request);
      }
      return 'ready';
    } catch (error) {
      permit.release();
      if (this.cancellation.isCancellation(error, cancellationSignal)) {
        return 'cancelled';
      }
      throw error;
    }
  }

  private acquirePermit(
    request: RunExecutorRequest,
    timeoutMs: number,
    cancellationSignal: AbortSignal,
  ): Promise<ProviderPermitAcquisition> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return this.providerCalls
      .acquire(
        request.runId,
        this.maximumParallelism,
        AbortSignal.any([cancellationSignal, timeoutSignal]),
      )
      .then((permit) => ({ kind: 'acquired', permit }) as const)
      .catch((error: unknown) => {
        if (this.cancellation.isCancellation(error, cancellationSignal)) {
          return { kind: 'cancelled' } as const;
        }
        if (timeoutSignal.aborted && !cancellationSignal.aborted) {
          return { kind: 'timedOut' } as const;
        }
        throw error;
      });
  }

  private async exhausted(
    request: RunExecutorRequest,
    reconciliationRound: number,
  ): ReturnType<ExecuteNodeEffect> {
    await this.reconciliation.checkpointUnknown(request, reconciliationRound);
    return { kind: 'recoveryExhausted', reconciliationRound };
  }
}
