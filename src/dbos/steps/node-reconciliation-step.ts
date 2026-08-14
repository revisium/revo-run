import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeReconciliation } from '../../contracts/executor/run-node-recovery.js';
import {
  assertExpectedRunExecutorRequest,
  parseRunNodeReconciliation,
  validReconciliationResult,
} from '../../validation/run-node-recovery.validator.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import {
  nodeReconciliationFailureStepName,
  nodeReconciliationOutcomeStepName,
  nodeReconciliationStepName,
} from '../dbos-names.js';
import type { ProviderCallPermit } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { isDbosStepTimeout, isDbosWorkflowCancelled } from './step-timeout.js';

export class NodeReconciliationStep {
  constructor(
    private readonly executor: RunExecutorProvider,
    private readonly cancellation: ScopeCancellationRegistry,
  ) {}

  async reconcile(
    request: RunExecutorRequest,
    reconciliationRound: number,
    timeoutMs: number,
    cancellationSignal: AbortSignal,
    permit: ProviderCallPermit,
  ): Promise<RunNodeReconciliation> {
    if (!this.executor.supportsReconciliation()) {
      permit.release();
      return this.checkpointUnknown(request, reconciliationRound);
    }
    let callbackOwnsPermit = false;
    try {
      const reconciliation = parseRunNodeReconciliation(
        await DBOS.runStep(
          async () => {
            callbackOwnsPermit = true;
            try {
              return await this.callExecutor(request, reconciliationRound, cancellationSignal);
            } finally {
              permit.release();
            }
          },
          {
            name: nodeReconciliationStepName(
              request.displayPath,
              request.attemptOrdinal,
              reconciliationRound,
            ),
            retriesAllowed: false,
            timeoutMS: timeoutMs,
          },
        ),
      );
      this.assertExpected(reconciliation, request, reconciliationRound);
      return reconciliation;
    } catch (error) {
      if (
        isDbosWorkflowCancelled(error) ||
        this.cancellation.isCancellation(error, cancellationSignal)
      ) {
        throw error;
      }
      if (!isDbosStepTimeout(error)) {
        throw error;
      }
      return this.checkpointFailure(request, reconciliationRound);
    } finally {
      if (!callbackOwnsPermit) {
        permit.release();
      }
    }
  }

  async checkpointUnknown(
    request: RunExecutorRequest,
    reconciliationRound: number,
  ): Promise<RunNodeReconciliation> {
    const reconciliation = parseRunNodeReconciliation(
      await DBOS.runStep(
        async () => ({
          kind: 'runNodeReconciliation',
          request,
          reconciliationRound,
          result: { kind: 'outcomeUnknown' },
        }),
        {
          name: nodeReconciliationOutcomeStepName(
            request.displayPath,
            request.attemptOrdinal,
            reconciliationRound,
          ),
          retriesAllowed: false,
        },
      ),
    );
    this.assertExpected(reconciliation, request, reconciliationRound);
    return reconciliation;
  }

  private async callExecutor(
    request: RunExecutorRequest,
    reconciliationRound: number,
    cancellationSignal: AbortSignal,
  ): Promise<RunNodeReconciliation> {
    const timeoutSignal = DBOS.stepStatus?.timeoutSignal;
    if (timeoutSignal === undefined) {
      throw new Error('DBOS did not provide a reconciliation timeout signal.');
    }
    const callSignal = AbortSignal.any([timeoutSignal, cancellationSignal]);
    if (cancellationSignal.aborted) {
      throw cancellationSignal.reason;
    }
    try {
      const result = await this.executor.reconcile(request, request.attemptId, {
        signal: callSignal,
      });
      if (cancellationSignal.aborted) {
        throw cancellationSignal.reason;
      }
      return validReconciliationResult(result)
        ? { kind: 'runNodeReconciliation', request, reconciliationRound, result }
        : { kind: 'reconciliationFailed', request, reconciliationRound };
    } catch (error) {
      if (cancellationSignal.aborted) {
        throw cancellationSignal.reason;
      }
      if (
        isDbosWorkflowCancelled(error) ||
        this.cancellation.isCancellation(error, cancellationSignal)
      ) {
        throw error;
      }
      return { kind: 'reconciliationFailed', request, reconciliationRound };
    }
  }

  private async checkpointFailure(
    request: RunExecutorRequest,
    reconciliationRound: number,
  ): Promise<RunNodeReconciliation> {
    const reconciliation = parseRunNodeReconciliation(
      await DBOS.runStep(
        async () => ({ kind: 'reconciliationFailed', request, reconciliationRound }),
        {
          name: nodeReconciliationFailureStepName(
            request.displayPath,
            request.attemptOrdinal,
            reconciliationRound,
          ),
          retriesAllowed: false,
        },
      ),
    );
    this.assertExpected(reconciliation, request, reconciliationRound);
    return reconciliation;
  }

  private assertExpected(
    reconciliation: RunNodeReconciliation,
    request: RunExecutorRequest,
    reconciliationRound: number,
  ): void {
    assertExpectedRunExecutorRequest(reconciliation.request, request);
    if (reconciliation.reconciliationRound !== reconciliationRound) {
      throw new Error('Stored node reconciliation round does not match the expected round.');
    }
  }
}
