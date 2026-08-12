import { DBOS, Error as DBOSError } from '@dbos-inc/dbos-sdk';

import type {
  EffectRecoverySpikeInput,
  EffectRecoverySpikeMessage,
  EffectRecoverySpikePhase,
  EffectRecoverySpikeScenario,
} from './effect-recovery-spike-protocol.js';

interface IntentRecord {
  readonly attemptId: string;
  readonly attemptOrdinal: 1;
  readonly generation: number;
}

interface MustReconcileDecision {
  readonly kind: 'mustReconcile';
  readonly liveGeneration: number;
  readonly storedGeneration: number;
}

interface EffectCompletedDecision {
  readonly kind: 'effectCompleted';
  readonly attemptId: string;
}

type EffectDecision = EffectCompletedDecision | MustReconcileDecision;

interface OutcomeUnknownResult {
  readonly attemptId: string;
  readonly kind: 'outcomeUnknown';
  readonly recovery: { readonly reconciliationRound: number };
}

type Report = (message: EffectRecoverySpikeMessage) => void;

const intentStepName = 'rr06-spike:intent:1';
const effectDecisionStepName = 'rr06-spike:effect-decision:1';
const reconcileStepName = (round: number): string => `rr06-spike:reconcile:${round}`;
export const effectRecoveryWaitTopic = 'rr06-spike:human-resolution';

const recoveryGeneration = async (): Promise<number> => {
  const workflowId = DBOS.workflowID;
  if (workflowId === undefined) {
    throw new Error('DBOS did not expose the active workflow identity.');
  }
  const status = await DBOS.getWorkflowStatus(workflowId);
  const generation = status?.recoveryAttempts;
  if (generation === undefined || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('DBOS did not expose a non-negative recovery generation.');
  }
  return generation;
};

const checkpointIntent = async (attemptId: string, report: Report): Promise<IntentRecord> => {
  const record: IntentRecord = {
    attemptId,
    attemptOrdinal: 1,
    generation: await recoveryGeneration(),
  };
  report({
    kind: 'intentCheckpointed',
    attemptOrdinal: record.attemptOrdinal,
    storedGeneration: record.generation,
  });
  return record;
};

const waitForever = async (): Promise<never> => new Promise(() => undefined);

const decideEffect = async (
  intent: IntentRecord,
  scenario: EffectRecoverySpikeScenario,
  phase: EffectRecoverySpikePhase,
  report: Report,
): Promise<EffectDecision> => {
  const liveGeneration = await recoveryGeneration();
  if (liveGeneration < intent.generation) {
    throw new Error('Live recovery generation decreased.');
  }
  if (liveGeneration > intent.generation) {
    return {
      kind: 'mustReconcile',
      liveGeneration,
      storedGeneration: intent.generation,
    };
  }

  report({ kind: 'effectExecuted', attemptOrdinal: intent.attemptOrdinal, liveGeneration });
  if (phase === 'start' && scenario !== 'crash-before-intent') {
    return waitForever();
  }
  return { kind: 'effectCompleted', attemptId: intent.attemptId };
};

const createReconciliation = (report: Report) => {
  let activeReconciliations = 0;

  const observeAmbiguousEffect = async (
    attemptId: string,
    phase: EffectRecoverySpikePhase,
    reconciliationRound: number,
  ): Promise<OutcomeUnknownResult> => {
    activeReconciliations += 1;
    report({ kind: 'reconcileStarted', activeReconciliations });

    if (phase === 'recover-hold-reconcile') {
      return waitForever();
    }
    if (phase === 'recover-timeout' && reconciliationRound === 1) {
      const signal = DBOS.stepStatus?.timeoutSignal;
      if (signal === undefined) {
        throw new Error('DBOS did not expose the reconciliation timeout signal.');
      }
      signal.addEventListener('abort', () => {
        report({ kind: 'reconcileTimedOut', activeReconciliations });
      });
      return waitForever();
    }

    return {
      attemptId,
      kind: 'outcomeUnknown',
      recovery: { reconciliationRound },
    };
  };

  const timed = async (attemptId: string): Promise<OutcomeUnknownResult> => {
    try {
      await DBOS.runStep(() => observeAmbiguousEffect(attemptId, 'recover-timeout', 1), {
        name: reconcileStepName(1),
        retriesAllowed: false,
        timeoutMS: 100,
      });
      throw new Error('The first reconciliation unexpectedly completed.');
    } catch (error) {
      if (!(error instanceof DBOSError.DBOSStepTimeoutError)) {
        throw error;
      }
    }

    return DBOS.runStep(() => observeAmbiguousEffect(attemptId, 'recover-complete', 2), {
      name: reconcileStepName(2),
      retriesAllowed: false,
    });
  };

  return async (
    attemptId: string,
    phase: EffectRecoverySpikePhase,
  ): Promise<OutcomeUnknownResult> => {
    if (phase === 'recover-timeout') {
      return timed(attemptId);
    }
    return DBOS.runStep(() => observeAmbiguousEffect(attemptId, phase, 1), {
      name: reconcileStepName(1),
      retriesAllowed: false,
    });
  };
};

const waitForResolution = async (
  attemptId: string,
  report: Report,
): Promise<OutcomeUnknownResult> => {
  report({ kind: 'waiting' });
  await DBOS.recv(effectRecoveryWaitTopic, { timeoutSeconds: 30 });
  return {
    attemptId,
    kind: 'outcomeUnknown',
    recovery: { reconciliationRound: 1 },
  };
};

const createEffectWorkflow = (phase: EffectRecoverySpikePhase, report: Report) => {
  const reconcile = createReconciliation(report);

  return async (input: EffectRecoverySpikeInput): Promise<unknown> => {
    if (input.scenario === 'single-wait') {
      return waitForResolution(input.attemptId, report);
    }
    if (phase === 'start' && input.scenario === 'crash-before-intent') {
      report({ kind: 'ready' });
      await waitForever();
    }

    const intent = await DBOS.runStep(() => checkpointIntent(input.attemptId, report), {
      name: intentStepName,
      retriesAllowed: false,
    });
    const decision = await DBOS.runStep(() => decideEffect(intent, input.scenario, phase, report), {
      name: effectDecisionStepName,
      retriesAllowed: false,
    });
    if (decision.kind === 'effectCompleted') {
      return decision;
    }

    report({
      kind: 'intentCheckpointed',
      liveGeneration: decision.liveGeneration,
      storedGeneration: decision.storedGeneration,
    });
    return reconcile(intent.attemptId, phase);
  };
};

export const registerEffectRecoverySpikeWorkflows = (
  phase: EffectRecoverySpikePhase,
  report: Report,
) => {
  const rootExecution = DBOS.registerWorkflow(createEffectWorkflow(phase, report), {
    name: 'rr06-spike-root-execution',
  });
  const parallelChild = DBOS.registerWorkflow(createEffectWorkflow(phase, report), {
    name: 'rr06-spike-parallel-child',
  });
  const parallelParent = DBOS.registerWorkflow(
    async (input: EffectRecoverySpikeInput) => {
      const child = await DBOS.startWorkflow(parallelChild, {
        workflowID: input.semanticWorkflowId,
      })(input);
      return child.getResult();
    },
    { name: 'rr06-spike-parallel-parent' },
  );

  return { parallelParent, rootExecution };
};
