interface PermitWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (permit: ProviderCallPermit) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

interface RunPermits {
  readonly limit: number;
  active: number;
  readonly queue: PermitWaiter[];
}

export interface ProviderCallPermit {
  release(): void;
}

/** Process-local FIFO capacity for provider execute and reconcile calls in one run. */
export class ProviderCallRegistry {
  private readonly runs = new Map<string, RunPermits>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();

  acquire(runId: string, limit: number, signal: AbortSignal): Promise<ProviderCallPermit> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    const permits = this.permits(runId, limit);
    if (permits.active < permits.limit && permits.queue.length === 0) {
      permits.active += 1;
      return Promise.resolve(this.permit(runId, permits));
    }

    return new Promise((resolve, reject) => {
      const waiter: PermitWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = permits.queue.indexOf(waiter);
          if (index >= 0) {
            permits.queue.splice(index, 1);
          }
          reject(signal.reason);
          this.deleteIfIdle(runId, permits);
        },
      };
      permits.queue.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  waitForIdle(runId: string): Promise<void> {
    const permits = this.runs.get(runId);
    if (permits === undefined || (permits.active === 0 && permits.queue.length === 0)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(runId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(runId, waiters);
    });
  }

  reset(): void {
    for (const permits of this.runs.values()) {
      for (const waiter of permits.queue) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(new Error('Provider call capacity was reset.'));
      }
    }
    this.runs.clear();
    for (const waiters of this.idleWaiters.values()) {
      for (const resolve of waiters) {
        resolve();
      }
    }
    this.idleWaiters.clear();
  }

  private permits(runId: string, limit: number): RunPermits {
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      if (existing.limit !== limit) {
        throw new Error('Provider call capacity changed during a run.');
      }
      return existing;
    }
    const permits = { limit, active: 0, queue: [] };
    this.runs.set(runId, permits);
    return permits;
  }

  private permit(runId: string, permits: RunPermits): ProviderCallPermit {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        permits.active -= 1;
        this.admitNext(runId, permits);
      },
    };
  }

  private admitNext(runId: string, permits: RunPermits): void {
    const waiter = permits.queue.shift();
    if (waiter === undefined) {
      this.deleteIfIdle(runId, permits);
      return;
    }
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.reject(waiter.signal.reason);
      this.admitNext(runId, permits);
      return;
    }
    permits.active += 1;
    waiter.resolve(this.permit(runId, permits));
  }

  private deleteIfIdle(runId: string, permits: RunPermits): void {
    if (permits.active === 0 && permits.queue.length === 0 && this.runs.get(runId) === permits) {
      this.runs.delete(runId);
      const waiters = this.idleWaiters.get(runId);
      if (waiters !== undefined) {
        this.idleWaiters.delete(runId);
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  }
}
