import { RunManagerError } from '../contracts/run/run-manager-error.js';

export const managerStopGraceMs = 5_000;
export const managerShutdownResponseMs = 5_000;

interface StartStopRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type ManagerState = 'stopped' | 'starting' | 'running' | 'stopping';

const withinDeadline = async <Result>(
  operation: Promise<Result>,
  durationMs: number,
): Promise<Result> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Manager lifecycle deadline expired.')), durationMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export class RunManagerLifecycle {
  private readonly runtime: StartStopRuntime;
  private state: ManagerState = 'stopped';
  private startOperation: Promise<void> | undefined;
  private stopOperation: Promise<void> | undefined;
  private shutdownStarted: Promise<void> | undefined;
  private controller = new AbortController();
  private readonly active = new Set<Promise<void>>();

  constructor(runtime: StartStopRuntime) {
    this.runtime = runtime;
    this.controller.abort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  assertRunning(): void {
    if (this.state !== 'running') {
      throw new RunManagerError('manager_not_started');
    }
  }

  async start(): Promise<void> {
    if (this.state === 'running') {
      return;
    }
    if (this.state === 'stopping') {
      try {
        await this.stopOperation;
      } catch {
        throw new RunManagerError('manager_start_failed');
      }
      return this.start();
    }
    if (this.startOperation !== undefined) {
      return this.waitForStart(this.startOperation);
    }

    this.state = 'starting';
    const operation = this.startRuntime();
    this.startOperation = operation;
    try {
      await this.waitForStart(operation);
    } finally {
      if (this.startOperation === operation) {
        this.startOperation = undefined;
      }
    }
  }

  stop(): Promise<void> {
    if (this.state === 'stopped') {
      return Promise.resolve();
    }
    if (this.stopOperation === undefined) {
      this.state = 'stopping';
      this.controller.abort();
      let announceShutdown: (() => void) | undefined;
      const shutdownStarted = new Promise<void>((resolve) => {
        announceShutdown = resolve;
      });
      this.shutdownStarted = shutdownStarted;
      const operation = this.stopRuntime(this.startOperation, () => announceShutdown?.());
      this.stopOperation = operation;
      void operation.then(
        () => {
          if (this.stopOperation === operation) {
            this.stopOperation = undefined;
            this.state = 'stopped';
          }
        },
        () => undefined,
      );
    }
    return this.waitForStop(this.stopOperation, this.shutdownStarted);
  }

  track<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.assertRunning();
    const result = operation();
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.active.add(settled);
    void settled.finally(() => this.active.delete(settled));
    return result;
  }

  trackSubscription(): () => void {
    this.assertRunning();
    let close: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      close = resolve;
    });
    this.active.add(settled);
    void settled.finally(() => this.active.delete(settled));
    return () => close?.();
  }

  private async startRuntime(): Promise<void> {
    try {
      await this.runtime.start();
    } catch (error) {
      if (this.state === 'starting') {
        this.state = 'stopped';
      }
      throw error;
    }
    if (this.state === 'starting') {
      this.controller = new AbortController();
      this.state = 'running';
    }
  }

  private async stopRuntime(
    starting: Promise<void> | undefined,
    announceShutdown: () => void,
  ): Promise<void> {
    if (starting !== undefined) {
      try {
        await starting;
      } catch {
        announceShutdown();
        return;
      }
    }
    await withinDeadline(Promise.allSettled(this.active), managerStopGraceMs).catch(
      () => undefined,
    );
    announceShutdown();
    await this.runtime.stop();
  }

  private async waitForStart(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch {
      throw new RunManagerError('manager_start_failed');
    }
  }

  private async waitForStop(
    operation: Promise<void>,
    shutdownStarted: Promise<void> | undefined,
  ): Promise<void> {
    try {
      await shutdownStarted;
      await withinDeadline(operation, managerShutdownResponseMs);
    } catch {
      throw new RunManagerError('manager_stop_failed');
    }
  }
}
