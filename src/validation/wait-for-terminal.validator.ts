import type { WaitForTerminalInput } from '../contracts/run/wait-for-terminal.js';

const keys = new Set(['timeoutMs', 'signal']);

const ownValue = (value: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(value, key)?.value;

export const isWaitForTerminalInput = (value: unknown): value is WaitForTerminalInput => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).some((key) => !keys.has(key))) {
    return false;
  }

  const timeoutMs = ownValue(value, 'timeoutMs');
  const signal = ownValue(value, 'signal');
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  ) {
    return false;
  }
  return signal === undefined || signal instanceof AbortSignal;
};
