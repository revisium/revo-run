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
