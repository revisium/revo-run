import assert from 'node:assert/strict';

import { describe, expect, it } from 'vitest';

import { recoveryScenarios } from '../acceptance/scenarios/recovery.scenarios.js';
import type { RunScenario } from '../dsl/scenario.js';
import { compileEffectRecoveryScenario } from '../support/process/effect-recovery-scenario-program.js';

const scenario = (intentId: string): RunScenario => {
  const candidate = recoveryScenarios.find((item) => item.intentId === intentId);
  assert(candidate !== undefined);
  return candidate;
};

describe('effect recovery scenario program', () => {
  it.each([
    ['rr-011', 'afterEffect', 'main/merge', 1, undefined],
    ['rr-013', 'afterEffect', 'main/notify', 1, undefined],
    ['rr-014', 'beforeEffect', 'main/commit', 0, 1],
    ['rr-015', 'afterEffect', 'main/deploy', 3, undefined],
    ['rr-016', 'afterEffect', 'main/publish', 1, 2],
  ] as const)(
    'compiles %s from declared business steps',
    (intentId, crashMoment, path, reconciliationCount, completionAttempt) => {
      const program = compileEffectRecoveryScenario(scenario(intentId));

      expect(program).toMatchObject({ crashMoment, path });
      expect(program.instructions).toHaveLength(reconciliationCount);
      expect(program.completion?.attempt).toBe(completionAttempt);
    },
  );

  it('rejects the RR-07 human-resolution command subset', () => {
    expect(() => compileEffectRecoveryScenario(scenario('rr-012'))).toThrow(
      'Recovery scenario step captureAttemptId is not supported.',
    );
  });

  it('rejects a reconciliation before restart', () => {
    const original = scenario('rr-011');
    const restart = original.steps.findIndex(({ kind }) => kind === 'restartManager');
    const reconciliation = original.steps.findIndex(({ kind }) => kind === 'reconcileNode');
    assert(restart >= 0, 'RR-011 must declare process recovery.');
    assert(reconciliation >= 0, 'RR-011 must declare effect reconciliation.');
    const steps = [...original.steps];
    const restartStep = steps[restart];
    const reconciliationStep = steps[reconciliation];
    assert(restartStep !== undefined, 'RR-011 process recovery step must exist.');
    assert(reconciliationStep !== undefined, 'RR-011 effect reconciliation step must exist.');
    steps[restart] = reconciliationStep;
    steps[reconciliation] = restartStep;

    expect(() => compileEffectRecoveryScenario({ ...original, steps })).toThrow(
      'Reconciliation must follow process recovery.',
    );
  });

  it('rejects a second effect path hidden in expectations', () => {
    const original = scenario('rr-011');
    const steps = [
      ...original.steps,
      { kind: 'expectExecutionCount', path: 'main/foreign', count: 1 } as const,
    ];

    expect(() => compileEffectRecoveryScenario({ ...original, steps })).toThrow(
      'Recovery scenario must address exactly one effect path.',
    );
  });

  it('rejects a new execution unless reconciliation proves the effect absent', () => {
    const original = scenario('rr-011');
    const steps = [
      ...original.steps.slice(0, -1),
      {
        kind: 'completeNode',
        path: 'main/merge',
        attempt: 2,
        outcome: 'completed',
      } as const,
      original.steps.at(-1),
    ].filter((step) => step !== undefined);

    expect(() => compileEffectRecoveryScenario({ ...original, steps })).toThrow(
      'Only a proven-absent effect permits a new execution.',
    );
  });
});
