import { DBOS } from '@dbos-inc/dbos-sdk';

import type {
  RunNodeEffectDecision,
  RunNodeEffectIntent,
} from '../../contracts/executor/run-node-recovery.js';
import { RunExecutorResultValidator } from '../../validation/run-executor-result.validator.js';
import {
  assertExpectedRunExecutorRequest,
  parseRunNodeEffectDecision,
} from '../../validation/run-node-recovery.validator.js';
import { nodeEffectDecisionStepName } from '../dbos-names.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { currentRecoveryGeneration } from './workflow-recovery-generation.js';

const assertDecisionGeneration = (
  decision: RunNodeEffectDecision,
  intent: RunNodeEffectIntent,
): void => {
  if (
    decision.kind === 'mustReconcile' &&
    (decision.storedRecoveryGeneration !== intent.recoveryGeneration ||
      decision.liveRecoveryGeneration <= decision.storedRecoveryGeneration)
  ) {
    throw new Error('Stored node effect decision generation is invalid.');
  }
};

export class NodeEffectDecisionStep {
  constructor(private readonly executor: RunExecutorProvider) {}

  async decide(intent: RunNodeEffectIntent, timeoutMs: number): Promise<RunNodeEffectDecision> {
    const decision = parseRunNodeEffectDecision(
      await DBOS.runStep(
        async () => {
          const liveRecoveryGeneration = await currentRecoveryGeneration();
          if (liveRecoveryGeneration < intent.recoveryGeneration) {
            throw new Error('Node effect recovery generation decreased.');
          }
          if (liveRecoveryGeneration > intent.recoveryGeneration) {
            return {
              kind: 'mustReconcile',
              request: intent.request,
              storedRecoveryGeneration: intent.recoveryGeneration,
              liveRecoveryGeneration,
            };
          }

          const signal = DBOS.stepStatus?.timeoutSignal;
          if (signal === undefined) {
            throw new Error('DBOS did not provide a step timeout signal.');
          }
          const result = await this.executor.execute(intent.request, { signal });
          if (!RunExecutorResultValidator.Check(result)) {
            throw new Error('Run executor returned an invalid result.');
          }
          return { kind: 'runNodeExecution', request: intent.request, result };
        },
        {
          name: nodeEffectDecisionStepName(
            intent.request.displayPath,
            intent.request.attemptOrdinal,
          ),
          retriesAllowed: false,
          timeoutMS: timeoutMs,
        },
      ),
    );
    assertDecisionGeneration(decision, intent);
    assertExpectedRunExecutorRequest(decision.request, intent.request);
    return decision;
  }
}
