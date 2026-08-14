import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunNodeEffectIntent } from '../../contracts/executor/run-node-recovery.js';
import { parseRunNodeEffectSelection } from '../../validation/run-node-effect-selection.validator.js';
import { assertExpectedRunExecutorRequest } from '../../validation/run-node-recovery.validator.js';
import { nodeEffectSelectionStepName } from '../dbos-names.js';
import { currentRecoveryGeneration } from './workflow-recovery-generation.js';

export class NodeEffectSelectionStep {
  async select(intent: RunNodeEffectIntent) {
    const selection = parseRunNodeEffectSelection(
      await DBOS.runStep(
        async () => {
          const liveRecoveryGeneration = await currentRecoveryGeneration();
          if (liveRecoveryGeneration < intent.recoveryGeneration) {
            throw new Error('Node effect recovery generation decreased.');
          }
          return {
            kind: 'runNodeEffectSelection',
            request: intent.request,
            mode: liveRecoveryGeneration === intent.recoveryGeneration ? 'execute' : 'reconcile',
            storedRecoveryGeneration: intent.recoveryGeneration,
            liveRecoveryGeneration,
          };
        },
        {
          name: nodeEffectSelectionStepName(
            intent.request.displayPath,
            intent.request.attemptOrdinal,
          ),
          retriesAllowed: false,
        },
      ),
    );
    assertExpectedRunExecutorRequest(selection.request, intent.request);
    if (
      selection.storedRecoveryGeneration !== intent.recoveryGeneration ||
      selection.liveRecoveryGeneration < selection.storedRecoveryGeneration ||
      (selection.mode === 'execute' &&
        selection.liveRecoveryGeneration !== selection.storedRecoveryGeneration) ||
      (selection.mode === 'reconcile' &&
        selection.liveRecoveryGeneration === selection.storedRecoveryGeneration)
    ) {
      throw new Error('Stored node effect selection generation is invalid.');
    }
    return selection;
  }
}
