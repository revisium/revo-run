import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import {
  RunNodeEffectDecisionSchema,
  RunNodeEffectIntentSchema,
  RunNodeReconciliationSchema,
} from '../../src/contracts/executor/run-node-recovery.js';
import { RunExecutorReconciliationResultSchema, type RunExecutorRequest } from '../../src/index.js';
import { storedNodeExecution } from '../support/run-details.fixture.js';

const resultValidator = Schema.Compile(RunExecutorReconciliationResultSchema);
const intentValidator = Schema.Compile(RunNodeEffectIntentSchema);
const decisionValidator = Schema.Compile(RunNodeEffectDecisionSchema);
const reconciliationValidator = Schema.Compile(RunNodeReconciliationSchema);

const request = storedNodeExecution('main/root-work', 'completed').request;

describe('effect recovery durable contracts', () => {
  it.each([
    { kind: 'effectCompleted', result: { kind: 'completed', outcome: 'completed' } },
    { kind: 'effectFailed', error: { code: 'provider_failed', message: 'Failed.' } },
    { kind: 'effectNotFound' },
    { kind: 'outcomeUnknown' },
  ])('accepts reconciliation result $kind', (result) => {
    expect(resultValidator.Check(result)).toBe(true);
  });

  it('rejects malformed and extended reconciliation results', () => {
    expect(resultValidator.Check({ kind: 'effectCompleted' })).toBe(false);
    expect(resultValidator.Check({ kind: 'effectNotFound', retry: true })).toBe(false);
    expect(
      resultValidator.Check({
        kind: 'effectFailed',
        error: { code: 'invalid code', message: 'Failed.' },
      }),
    ).toBe(false);
  });

  it('validates immutable intent and generation-fence decisions', () => {
    expect(
      intentValidator.Check({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: 0,
      }),
    ).toBe(true);
    expect(
      decisionValidator.Check({
        kind: 'mustReconcile',
        request,
        storedRecoveryGeneration: 0,
        liveRecoveryGeneration: 1,
      }),
    ).toBe(true);
    expect(
      intentValidator.Check({
        kind: 'runNodeEffectIntent',
        request,
        recoveryGeneration: -1,
      }),
    ).toBe(false);
  });

  it('requires a positive reconciliation round and exact nested result', () => {
    const recovery = (
      reconciliationRound: number,
      effectRequest: RunExecutorRequest = request,
    ) => ({
      kind: 'runNodeReconciliation',
      request: effectRequest,
      reconciliationRound,
      result: { kind: 'outcomeUnknown' },
    });

    expect(reconciliationValidator.Check(recovery(1))).toBe(true);
    expect(reconciliationValidator.Check(recovery(0))).toBe(false);
    expect(reconciliationValidator.Check({ ...recovery(1), extra: true })).toBe(false);
  });
});
