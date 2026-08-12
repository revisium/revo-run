import type { ScenarioStep } from './scenario.js';

const requireSafeInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer.`);
  }
};

export const advanceLogicalTime = (currentTimeMs: number, durationMs: number): number => {
  requireSafeInteger(currentTimeMs, 'Current logical time');
  requireSafeInteger(durationMs, 'Time advancement');
  if (currentTimeMs < 0) {
    throw new RangeError('Current logical time must not be negative.');
  }
  if (durationMs <= 0) {
    throw new RangeError('Time advancement must be positive.');
  }

  const advancedTimeMs = currentTimeMs + durationMs;
  requireSafeInteger(advancedTimeMs, 'Advanced logical time');
  return advancedTimeMs;
};

export const scenarioRealTimeMs = (steps: readonly ScenarioStep[]): number =>
  steps.reduce(
    (durationMs, step) =>
      step.kind === 'advanceTime' ? advanceLogicalTime(durationMs, step.durationMs) : durationMs,
    0,
  );

const managerRestartAllowanceMs = 15_000;
const assertionAllowanceMs = 15_000;

export const scenarioTimeoutMs = (steps: readonly ScenarioStep[]): number =>
  scenarioRealTimeMs(steps) +
  steps.filter(({ kind }) => kind === 'crashManager').length * managerRestartAllowanceMs +
  assertionAllowanceMs;
