import { describe, expect, it } from 'vitest';

import {
  isNodeEffectDecisionStepName,
  nodeAttemptStepIdentity,
  nodeEffectDecisionStepName,
  nodeReconciliationFailureStepName,
  nodeReconciliationOutcomeStepName,
  nodeReconciliationStepIdentity,
  nodeReconciliationStepName,
  parallelBranchWorkflowName,
  repeatIterationWorkflowName,
  runExecutionWorkflowName,
  runWorkflowName,
} from '../../src/dbos/dbos-names.js';

describe('DBOS workflow names', () => {
  it('uses the canonical namespace for every workflow kind', () => {
    expect(runWorkflowName).toBe('revo-run.run');
    expect(runExecutionWorkflowName).toBe('revo-run.execution');
    expect(parallelBranchWorkflowName).toBe('revo-run.parallel-branch');
    expect(repeatIterationWorkflowName).toBe('revo-run.repeat-iteration');
  });
});

describe('DBOS node reconciliation step identity', () => {
  it.each([
    ['result', nodeReconciliationStepName('main/review', 2, 3)],
    ['failure', nodeReconciliationFailureStepName('main/review', 2, 3)],
    ['outcome', nodeReconciliationOutcomeStepName('main/review', 2, 3)],
  ])('round-trips the %s checkpoint identity', (_kind, name) => {
    expect(nodeReconciliationStepIdentity(name)).toEqual({
      attemptOrdinal: 2,
      reconciliationRound: 3,
      displayPath: 'main/review',
    });
    expect(nodeAttemptStepIdentity(name)).toEqual({
      attemptOrdinal: 2,
      displayPath: 'main/review',
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid authored reconciliation round %s',
    (reconciliationRound) => {
      expect(() => nodeReconciliationStepName('main/review', 1, reconciliationRound)).toThrow(
        'positive safe integer',
      );
    },
  );

  it.each([
    'node-effect-reconcile:1:main/review',
    'node-effect-reconcile:1:0:main/review',
    'node-effect-reconcile:1:01:main/review',
    'node-effect-reconcile:1:1.5:main/review',
    'node-effect-reconcile:1:1:',
  ])('rejects malformed durable reconciliation identity %s', (name) => {
    expect(() => nodeReconciliationStepIdentity(name)).toThrow('identity');
  });

  it('rejects an unsafe parsed reconciliation round with a type error', () => {
    expect(() =>
      nodeReconciliationStepIdentity('node-effect-reconcile:1:9007199254740992:main/review'),
    ).toThrow(TypeError);
  });
});

describe('DBOS node execution step identity', () => {
  it('round-trips the display path and positive attempt ordinal', () => {
    const name = nodeEffectDecisionStepName('main/review', 2);

    expect(name).toBe('node-effect-decision:2:main/review');
    expect(isNodeEffectDecisionStepName(name)).toBe(true);
    expect(nodeAttemptStepIdentity(name)).toEqual({
      attemptOrdinal: 2,
      displayPath: 'main/review',
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid authored attempt ordinal %s',
    (attemptOrdinal) => {
      expect(() => nodeEffectDecisionStepName('main/review', attemptOrdinal)).toThrow(
        'positive safe integer',
      );
    },
  );

  it.each([
    'node-effect-decision:12',
    'node-effect-decision:0:main/review',
    'node-effect-decision:01:main/review',
    'node-effect-decision:1.5:main/review',
    'node-effect-decision:1:',
  ])('rejects malformed durable identity %s', (name) => {
    expect(isNodeEffectDecisionStepName(name)).toBe(true);
    expect(() => nodeAttemptStepIdentity(name)).toThrow('identity');
  });

  it('rejects an unsafe parsed attempt ordinal with a type error', () => {
    expect(() =>
      nodeAttemptStepIdentity('node-effect-decision:9007199254740992:main/review'),
    ).toThrow(TypeError);
  });
});
