const cancellationReason = Symbol('revo-run.scope-cancelled');

export class ScopeCancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();
  private readonly runScopes = new Map<string, Set<string>>();

  signal(runId: string, scopeId: string): AbortSignal {
    let controller = this.controllers.get(scopeId);
    if (controller === undefined) {
      controller = new AbortController();
      this.controllers.set(scopeId, controller);
      const scopes = this.runScopes.get(runId) ?? new Set<string>();
      scopes.add(scopeId);
      this.runScopes.set(runId, scopes);
    }
    return controller.signal;
  }

  cancelRun(runId: string): void {
    for (const scopeId of this.runScopes.get(runId) ?? []) {
      this.controllers.get(scopeId)?.abort(cancellationReason);
    }
  }

  cancelScope(scopeId: string): void {
    this.controllers.get(scopeId)?.abort(cancellationReason);
  }

  release(runId: string, scopeId: string): void {
    this.controllers.delete(scopeId);
    const scopes = this.runScopes.get(runId);
    scopes?.delete(scopeId);
    if (scopes?.size === 0) {
      this.runScopes.delete(runId);
    }
  }

  isCancellation(error: unknown, signal: AbortSignal): boolean {
    return signal.aborted && signal.reason === cancellationReason && error === cancellationReason;
  }

  reset(): void {
    this.controllers.clear();
    this.runScopes.clear();
  }
}
