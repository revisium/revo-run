import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeEffectDecision } from '../../contracts/executor/run-node-recovery.js';
import { RunExecutorResultValidator } from '../../validation/run-executor-result.validator.js';
import {
  assertExpectedRunExecutorRequest,
  parseRunNodeEffectDecision,
} from '../../validation/run-node-recovery.validator.js';
import { nodeEffectDecisionStepName } from '../dbos-names.js';
import type { ProviderCallPermit } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { currentRecoveryGeneration } from './workflow-recovery-generation.js';

export class NodeEffectDecisionStep {
  constructor(private readonly executor: RunExecutorProvider) {}

  async execute(
    request: RunExecutorRequest,
    timeoutMs: number,
    cancellationSignal: AbortSignal,
    storedRecoveryGeneration: number,
    permit: ProviderCallPermit,
  ): Promise<RunNodeEffectDecision> {
    let callbackOwnsPermit = false;
    try {
      const stored = await this.checkpoint(request, timeoutMs, async (timeoutSignal) => {
        callbackOwnsPermit = true;
        try {
          const liveRecoveryGeneration = await currentRecoveryGeneration();
          if (liveRecoveryGeneration < storedRecoveryGeneration) {
            throw new Error('Node effect recovery generation decreased.');
          }
          if (liveRecoveryGeneration > storedRecoveryGeneration) {
            return {
              kind: 'mustReconcile',
              request,
              storedRecoveryGeneration,
              liveRecoveryGeneration,
            };
          }
          const callSignal = AbortSignal.any([timeoutSignal, cancellationSignal]);
          if (cancellationSignal.aborted) {
            return { kind: 'runNodeCancelled', request };
          }
          try {
            const result = await this.executor.execute(request, { signal: callSignal });
            if (cancellationSignal.aborted) {
              return { kind: 'runNodeCancelled', request };
            }
            if (!RunExecutorResultValidator.Check(result)) {
              throw new Error('Run executor returned an invalid result.');
            }
            return { kind: 'runNodeExecution', request, result };
          } catch (error) {
            if (cancellationSignal.aborted) {
              return { kind: 'runNodeCancelled', request };
            }
            throw error;
          }
        } finally {
          permit.release();
        }
      });
      if (
        stored.kind === 'mustReconcile' &&
        (stored.storedRecoveryGeneration !== storedRecoveryGeneration ||
          stored.liveRecoveryGeneration <= stored.storedRecoveryGeneration)
      ) {
        throw new Error('Stored node effect decision generation is invalid.');
      }
      return stored;
    } finally {
      if (!callbackOwnsPermit) {
        permit.release();
      }
    }
  }

  cancelled(request: RunExecutorRequest, timeoutMs: number): Promise<RunNodeEffectDecision> {
    return this.checkpoint(request, timeoutMs, async () => ({ kind: 'runNodeCancelled', request }));
  }

  private async checkpoint(
    request: RunExecutorRequest,
    timeoutMs: number,
    decision: (timeoutSignal: AbortSignal) => Promise<RunNodeEffectDecision>,
  ): Promise<RunNodeEffectDecision> {
    const stored = parseRunNodeEffectDecision(
      await DBOS.runStep(
        async () => {
          const timeoutSignal = DBOS.stepStatus?.timeoutSignal;
          if (timeoutSignal === undefined) {
            throw new Error('DBOS did not provide a step timeout signal.');
          }
          return decision(timeoutSignal);
        },
        {
          name: nodeEffectDecisionStepName(request.displayPath, request.attemptOrdinal),
          retriesAllowed: false,
          timeoutMS: timeoutMs,
        },
      ),
    );
    assertExpectedRunExecutorRequest(stored.request, request);
    return stored;
  }
}
