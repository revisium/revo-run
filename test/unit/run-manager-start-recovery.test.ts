import { describe, expect, it } from 'vitest';

import type { ManagerLifecycleFacade } from '../../src/lifecycle/index.js';
import { DefaultRunManager } from '../../src/manager/construction.js';

describe('RunManager starting recovery cleanup', () => {
  it.each(['prepare_reconciliation', 'renew_lease', 'progression'] as const)(
    'hands off %s recovery failure once, restores stopped, and permits restart',
    async (stage) => {
      const failure = new TypeError(`${stage} failed`);
      let starts = 0;
      let active: { readonly attemptId: string; readonly fencingToken: number } | undefined;
      const handoffs: Array<{
        readonly attemptId: string;
        readonly fencingToken: number;
        readonly reason: string;
      }> = [];
      let lateWrites = 0;
      const lifecycle: ManagerLifecycleFacade = {
        beginStartCycle: () => `manager-${starts + 1}`,
        getRun: async () => undefined,
        handoffActive: async (_managerIncarnationId, reason = 'manager_shutdown') => {
          if (active === undefined) return;
          handoffs.push({ ...active, reason });
          active = undefined;
        },
        recover: async () => {
          starts += 1;
          if (starts !== 1) return;
          active = { attemptId: 'attempt-recovery', fencingToken: 7 };
          throw failure;
        },
        runOne: async () => {
          lateWrites += 1;
        },
        startRun: async (command) => ({
          createdAt: 0,
          id: 'unused',
          input: command.input,
          plan: command.plan,
          status: 'running',
          terminalAt: null,
          terminalFault: null,
          updatedAt: 0,
        }),
      };
      const manager = new DefaultRunManager({
        drainTimeoutMs: 10,
        lifecycle,
        pollIntervalMs: 60_000,
      });

      await expect(manager.start()).rejects.toBe(failure);
      expect(handoffs).toEqual([
        {
          attemptId: 'attempt-recovery',
          fencingToken: 7,
          reason: 'manager_start_failure',
        },
      ]);
      await manager.stop();
      expect(handoffs).toHaveLength(1);

      await manager.start();
      expect(starts).toBe(2);
      await manager.stop();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(lateWrites).toBe(0);
    },
  );

  it('preserves recovery authority after cleanup failure and retries the same handoff on stop', async () => {
    const recoveryError = new TypeError('recovery failed');
    const cleanupError = new TypeError('handoff failed');
    const handoffs: Array<{
      readonly managerIncarnationId: string;
      readonly reason: string;
    }> = [];
    let cleanupAttempts = 0;
    let lateWrites = 0;
    const lifecycle: ManagerLifecycleFacade = {
      beginStartCycle: () => 'manager-1',
      getRun: async () => undefined,
      handoffActive: async (managerIncarnationId, reason = 'manager_shutdown') => {
        cleanupAttempts += 1;
        handoffs.push({ managerIncarnationId, reason });
        if (cleanupAttempts === 1) throw cleanupError;
      },
      recover: async () => Promise.reject(recoveryError),
      runOne: async () => {
        lateWrites += 1;
      },
      startRun: async (command) => ({
        createdAt: 0,
        id: 'unused',
        input: command.input,
        plan: command.plan,
        status: 'running',
        terminalAt: null,
        terminalFault: null,
        updatedAt: 0,
      }),
    };
    const manager = new DefaultRunManager({
      drainTimeoutMs: 10,
      lifecycle,
      pollIntervalMs: 60_000,
    });

    const rejected = manager.start();
    await expect(rejected).rejects.toBeInstanceOf(AggregateError);
    await expect(rejected).rejects.toMatchObject({ errors: [recoveryError, cleanupError] });
    await expect(manager.start()).rejects.toThrow('INVALID_STATE');
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(handoffs).toEqual([
      { managerIncarnationId: 'manager-1', reason: 'manager_start_failure' },
      { managerIncarnationId: 'manager-1', reason: 'manager_start_failure' },
    ]);
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lateWrites).toBe(0);
  });

  it('restores stopped when start-cycle identity generation fails before authority acquisition', async () => {
    const identityError = new TypeError('identity generation failed');
    let attempts = 0;
    const lifecycle: ManagerLifecycleFacade = {
      beginStartCycle: () => {
        attempts += 1;
        if (attempts === 1) throw identityError;
        return 'manager-2';
      },
      getRun: async () => undefined,
      handoffActive: async () => undefined,
      recover: async () => undefined,
      runOne: async () => undefined,
      startRun: async (command) => ({
        createdAt: 0,
        id: 'unused',
        input: command.input,
        plan: command.plan,
        status: 'running',
        terminalAt: null,
        terminalFault: null,
        updatedAt: 0,
      }),
    };
    const manager = new DefaultRunManager({
      drainTimeoutMs: 10,
      lifecycle,
      pollIntervalMs: 60_000,
    });

    await expect(manager.start()).rejects.toBe(identityError);
    await expect(manager.start()).resolves.toBeUndefined();
    await manager.stop();
  });
});
