import { RunManagerError } from '../../contracts/run/run-manager-error.js';
import type { RunSnapshot } from '../../contracts/run/run.js';
import type { WaitForTerminalInput } from '../../contracts/run/wait-for-terminal.js';

const pollIntervalMs = 25;

const terminal = (run: RunSnapshot): boolean =>
  run.status !== 'pending' && run.status !== 'running';

const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted ?? false;

export const waitForTerminalRun = (
  read: () => Promise<RunSnapshot | undefined>,
  input: WaitForTerminalInput,
  managerSignal: AbortSignal,
): Promise<RunSnapshot> => {
  const invokedAt = Date.now();
  const deadline = input.timeoutMs === undefined ? undefined : invokedAt + input.timeoutMs;
  if (managerSignal.aborted) {
    return Promise.reject(new RunManagerError('manager_not_started'));
  }
  if (aborted(input.signal)) {
    return Promise.reject(new RunManagerError('run_wait_aborted'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      managerSignal.removeEventListener('abort', finishAbort);
      input.signal?.removeEventListener('abort', finishAbort);
    };

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (result: RunSnapshot): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    function finishAbort(): boolean {
      if (settled) {
        return true;
      }
      if (managerSignal.aborted) {
        rejectOnce(new RunManagerError('manager_not_started'));
        return true;
      }
      if (aborted(input.signal)) {
        rejectOnce(new RunManagerError('run_wait_aborted'));
        return true;
      }
      return false;
    }

    function finish(result: RunSnapshot | undefined, error?: unknown): void {
      if (settled || finishAbort()) {
        return;
      }
      if (result !== undefined && terminal(result)) {
        resolveOnce(result);
        return;
      }
      if (error !== undefined) {
        rejectOnce(error);
        return;
      }
      if (result === undefined) {
        rejectOnce(new RunManagerError('run_not_found'));
        return;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        rejectOnce(new RunManagerError('run_wait_timed_out'));
        return;
      }
      schedule();
    }

    function readOnce(): void {
      let operation: Promise<RunSnapshot | undefined>;
      try {
        operation = read();
      } catch (error) {
        finish(undefined, error);
        return;
      }
      operation.then(
        (result) => finish(result),
        (error: unknown) => finish(undefined, error),
      );
    }

    function schedule(): void {
      const remaining = deadline === undefined ? pollIntervalMs : deadline - Date.now();
      timer = setTimeout(readOnce, Math.max(1, Math.min(pollIntervalMs, remaining)));
    }

    managerSignal.addEventListener('abort', finishAbort, { once: true });
    input.signal?.addEventListener('abort', finishAbort, { once: true });
    if (finishAbort()) {
      return;
    }
    readOnce();
  });
};
