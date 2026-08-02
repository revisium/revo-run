import type { ManagerLifecycleFacade } from '../lifecycle/index.js';
import type { RunManager } from './run-manager.js';
import type { RunSnapshot } from './run-snapshot.js';
import type { StartRunCommand } from './start-run-command.js';

interface DefaultRunManagerOptions {
  readonly lifecycle: ManagerLifecycleFacade;
  readonly pollIntervalMs: number;
  readonly drainTimeoutMs: number;
}

type State = 'stopped' | 'starting' | 'running' | 'quiescing' | 'draining';

export class DefaultRunManager implements RunManager {
  readonly #options: DefaultRunManagerOptions;
  #state: State = 'stopped';
  #incarnation = '';
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #recoveryAbort: AbortController | undefined;
  #startFailureCleanupPending = false;
  #transition: Promise<void> = Promise.resolve();
  #backgroundFailure: unknown;

  constructor(options: DefaultRunManagerOptions) {
    this.#options = options;
  }

  start(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#state === 'running') return;
      if (this.#state !== 'stopped') throw new TypeError('INVALID_STATE: manager is stopping.');
      this.#state = 'starting';
      try {
        this.#incarnation = this.#options.lifecycle.beginStartCycle();
      } catch (error) {
        this.#state = 'stopped';
        throw error;
      }
      const recoveryAbort = new AbortController();
      this.#recoveryAbort = recoveryAbort;
      try {
        await this.#options.lifecycle.recover(this.#incarnation, recoveryAbort.signal);
      } catch (error) {
        recoveryAbort.abort(error);
        try {
          await this.#options.lifecycle.handoffActive(this.#incarnation, 'manager_start_failure');
        } catch (cleanupError) {
          this.#startFailureCleanupPending = true;
          this.#state = 'draining';
          // eslint-disable-next-line preserve-caught-error -- AggregateError retains both recovery and cleanup errors in order.
          throw new AggregateError(
            [error, cleanupError],
            'Manager recovery and manager_start_failure handoff both failed.',
            { cause: error },
          );
        }
        this.#recoveryAbort = undefined;
        this.#incarnation = '';
        this.#startFailureCleanupPending = false;
        this.#state = 'stopped';
        throw error;
      }
      this.#recoveryAbort = undefined;
      if (recoveryAbort.signal.aborted) {
        await this.#options.lifecycle.handoffActive(this.#incarnation);
        return;
      }
      this.#state = 'running';
      this.#schedule(0, this.#incarnation);
    });
  }

  stop(options: { readonly drain?: boolean } = {}): Promise<void> {
    this.#recoveryAbort?.abort(new Error('Run manager stopped during recovery.'));
    return this.#serialize(async () => {
      if (this.#state === 'stopped') return;
      this.#state = 'quiescing';
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#state = 'draining';
      const incarnation = this.#incarnation;
      if (this.#startFailureCleanupPending) {
        await this.#options.lifecycle.handoffActive(incarnation, 'manager_start_failure');
        this.#startFailureCleanupPending = false;
        this.#recoveryAbort = undefined;
        this.#incarnation = '';
        this.#state = 'stopped';
        return;
      }
      if (this.#active !== undefined) {
        if (options.drain !== true) {
          await this.#options.lifecycle.handoffActive(incarnation);
          this.#abort?.abort(new Error('Run manager stopped.'));
        }
        const drained = await this.#waitForActive();
        if (!drained) {
          await this.#options.lifecycle.handoffActive(incarnation);
          this.#abort?.abort(new Error('Run manager drain timed out.'));
          await this.#waitForActive();
        }
      }
      this.#abort = undefined;
      this.#incarnation = '';
      this.#state = 'stopped';
      if (this.#backgroundFailure !== undefined) {
        const failure = this.#backgroundFailure;
        this.#backgroundFailure = undefined;
        throw failure;
      }
    });
  }

  startRun(command: StartRunCommand): Promise<RunSnapshot> {
    return this.#options.lifecycle.startRun(command);
  }

  getRun(runId: string): Promise<RunSnapshot | undefined> {
    return this.#options.lifecycle.getRun(runId);
  }

  #schedule(delay: number, incarnation: string): void {
    if (this.#state !== 'running' || this.#timer !== undefined || this.#active !== undefined)
      return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#state !== 'running' || incarnation !== this.#incarnation) return;
      const abort = new AbortController();
      this.#abort = abort;
      this.#active = this.#options.lifecycle
        .runOne(incarnation, abort.signal)
        .catch((error: unknown) => {
          this.#backgroundFailure = error;
        })
        .finally(() => {
          this.#active = undefined;
          this.#abort = undefined;
          if (this.#state === 'running' && incarnation === this.#incarnation) {
            this.#schedule(this.#options.pollIntervalMs, incarnation);
          }
        });
    }, delay);
  }

  #serialize(action: () => Promise<void>): Promise<void> {
    const transition = this.#transition.then(action);
    this.#transition = transition.catch(() => undefined);
    return transition;
  }

  #waitForActive(): Promise<boolean> {
    const active = this.#active;
    if (active === undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), this.#options.drainTimeoutMs);
      void active.finally(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }
}
