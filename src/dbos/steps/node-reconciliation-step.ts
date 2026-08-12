import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeReconciliation } from '../../contracts/executor/run-node-recovery.js';
import {
  assertExpectedRunExecutorRequest,
  parseRunNodeReconciliation,
  validReconciliationResult,
} from '../../validation/run-node-recovery.validator.js';
import {
  nodeReconciliationFailureStepName,
  nodeReconciliationOutcomeStepName,
  nodeReconciliationStepName,
} from '../dbos-names.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { isDbosStepTimeout, isDbosWorkflowCancelled } from './step-timeout.js';

export class NodeReconciliationStep {
  constructor(private readonly executor: RunExecutorProvider) {}

  async reconcile(
    request: RunExecutorRequest,
    reconciliationRound: number,
    timeoutMs: number,
  ): Promise<RunNodeReconciliation> {
    if (!this.executor.supportsReconciliation()) {
      return this.checkpointUnknown(request, reconciliationRound);
    }
    try {
      const reconciliation = parseRunNodeReconciliation(
        await DBOS.runStep(async () => this.callExecutor(request, reconciliationRound), {
          name: nodeReconciliationStepName(
            request.displayPath,
            request.attemptOrdinal,
            reconciliationRound,
          ),
          retriesAllowed: false,
          timeoutMS: timeoutMs,
        }),
      );
      this.assertExpected(reconciliation, request, reconciliationRound);
      return reconciliation;
    } catch (error) {
      if (isDbosWorkflowCancelled(error)) {
        throw error;
      }
      if (!isDbosStepTimeout(error)) {
        throw error;
      }
      return this.checkpointFailure(request, reconciliationRound);
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
  ): Promise<RunNodeReconciliation> {
    const signal = DBOS.stepStatus?.timeoutSignal;
    if (signal === undefined) {
      throw new Error('DBOS did not provide a reconciliation timeout signal.');
    }
    try {
      const result = await this.executor.reconcile(request, request.attemptId, { signal });
      return validReconciliationResult(result)
        ? { kind: 'runNodeReconciliation', request, reconciliationRound, result }
        : { kind: 'reconciliationFailed', request, reconciliationRound };
    } catch (error) {
      if (isDbosWorkflowCancelled(error)) {
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
