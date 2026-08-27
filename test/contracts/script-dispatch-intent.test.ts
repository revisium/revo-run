import { describe, expect, it } from 'vitest';

import {
  requireScriptDispatchRecoveryAttempt,
  scriptDispatchAction,
} from '../../src/dbos/operation-workflow.js';

describe('RN1 script dispatch intent', () => {
  it('fails closed when the live recovery count is missing or invalid', () => {
    for (const value of [undefined, null, -1, 1.5, Number.POSITIVE_INFINITY, '1']) {
      expect(() => requireScriptDispatchRecoveryAttempt(value)).toThrow(
        'Script operation cannot read its durable recovery attempt.',
      );
    }
  });

  it('executes only at each physical dispatch baseline and reconciles every later recovery', () => {
    expect(scriptDispatchAction(0, 0)).toBe('execute');
    expect(scriptDispatchAction(3, 4)).toBe('reconcile');
    // A later physical retry has its own intent and consequently its own baseline.
    expect(scriptDispatchAction(7, 7)).toBe('execute');
    expect(() => scriptDispatchAction(4, 3)).toThrow(
      'Script operation recovery attempt decreased after dispatch intent.',
    );
  });
});
