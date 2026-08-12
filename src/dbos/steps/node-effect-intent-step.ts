import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunNodeEffectIntent } from '../../contracts/executor/run-node-recovery.js';
import {
  assertExpectedRunExecutorRequest,
  parseRunNodeEffectIntent,
} from '../../validation/run-node-recovery.validator.js';
import { nodeEffectIntentStepName } from '../dbos-names.js';
import { currentRecoveryGeneration } from './workflow-recovery-generation.js';

export class NodeEffectIntentStep {
  async checkpoint(request: RunExecutorRequest): Promise<RunNodeEffectIntent> {
    const intent = parseRunNodeEffectIntent(
      await DBOS.runStep(
        async () => ({
          kind: 'runNodeEffectIntent',
          request,
          recoveryGeneration: await currentRecoveryGeneration(),
        }),
        {
          name: nodeEffectIntentStepName(request.displayPath, request.attemptOrdinal),
          retriesAllowed: false,
        },
      ),
    );
    assertExpectedRunExecutorRequest(intent.request, request);
    return intent;
  }
}
