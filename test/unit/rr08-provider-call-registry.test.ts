import { describe, expect, it, vi } from 'vitest';

import { ProviderCallRegistry } from '../../src/dbos/executor/provider-call-registry.js';

describe('RR-08 provider call registry', () => {
  it('admits queued calls in FIFO order across nested scopes', async () => {
    const registry = new ProviderCallRegistry();
    const signal = new AbortController().signal;
    const first = await registry.acquire('run', 1, signal);
    const order: string[] = [];
    const second = registry.acquire('run', 1, signal).then((release) => {
      order.push('nested-a');
      return release;
    });
    const third = registry.acquire('run', 1, signal).then((release) => {
      order.push('nested-b');
      return release;
    });

    first.release();
    const secondPermit = await second;
    expect(order).toEqual(['nested-a']);
    secondPermit.release();
    const thirdPermit = await third;
    expect(order).toEqual(['nested-a', 'nested-b']);
    thirdPermit.release();
  });

  it('removes a cancelled waiter without consuming capacity', async () => {
    const registry = new ProviderCallRegistry();
    const activeSignal = new AbortController().signal;
    const queued = new AbortController();
    const first = await registry.acquire('run', 1, activeSignal);
    const cancelled = registry.acquire('run', 1, queued.signal);
    const next = registry.acquire('run', 1, activeSignal);

    queued.abort('cancelled');
    await expect(cancelled).rejects.toBe('cancelled');
    first.release();
    const permit = await next;
    permit.release();
    await vi.waitFor(() => expect(true).toBe(true));
  });

  it('keeps the run idle barrier pending until every actual permit is released', async () => {
    const registry = new ProviderCallRegistry();
    const permit = await registry.acquire('run', 1, new AbortController().signal);
    const idle = vi.fn<() => void>();
    void registry.waitForIdle('run').then(idle);

    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
    permit.release();
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
    await expect(registry.waitForIdle('run')).resolves.toBeUndefined();
  });
});
