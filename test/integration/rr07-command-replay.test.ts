import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { CommandDispatchWorkflowInput } from '../../src/contracts/workflow/run-command-workflow.js';
import { orphanHealthCheckSeconds } from '../../src/dbos/coordination/orphan-health-check.js';
import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { loadAllWorkflowSteps } from '../../src/dbos/read-model/dbos-step-pages.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import type { RunExecutorResult } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { testDatabaseUrl } from '../support/test-environment.js';

describe('RR-07 durable command replay', () => {
  it('replays one internal ID, rejects conflicting input, and emits one decision event', async () => {
    let settleProvider: ((result: RunExecutorResult) => void) | undefined;
    let providerStarted = false;
    let providerAborted = false;
    let providerScopeId: string | undefined;
    const settle = (result: RunExecutorResult): void => {
      if (settleProvider === undefined) {
        throw new Error('Provider is not pending.');
      }
      settleProvider(result);
    };
    const workflows = new WorkflowRegistry();
    const runtime = new DbosRunRuntime(
      testDatabaseUrl(),
      {
        execute: async (request, { signal }) => {
          providerStarted = true;
          providerScopeId = request.scopeId;
          signal.addEventListener('abort', () => {
            providerAborted = true;
          });
          return new Promise<RunExecutorResult>((resolve) => {
            settleProvider = resolve;
          });
        },
      },
      workflows,
    );
    await runtime.start();
    const runId = `command-replay-${randomUUID()}`;
    const commandId = `cmd_${randomUUID()}` as const;
    const input: CommandDispatchWorkflowInput = {
      commandId,
      command: { kind: 'cancelRun', input: { runId, actorId: 'operator' } },
    };
    try {
      await runtime.startRun(
        runId,
        executionPlan(sequence(task('work'), end('succeeded')), {
          bindings: [agentBinding('work', 'developer')],
        }),
        null,
      );
      await vi.waitFor(() => expect(providerStarted).toBe(true));

      const first = await runtime.dispatchCommand(input.command, commandId);
      expect(first).toEqual({ status: 'accepted', commandId });
      await vi.waitFor(() => expect(providerAborted).toBe(true));

      await expect(runtime.dispatchCommand(input.command, commandId)).resolves.toEqual(first);

      const conflicting: CommandDispatchWorkflowInput = {
        ...input,
        command: { kind: 'cancelRun', input: { runId, actorId: 'other-operator' } },
      };
      await expect(runtime.dispatchCommand(conflicting.command, commandId)).rejects.toMatchObject({
        code: 'run_command_failed',
        commandId,
      });

      settle({ kind: 'completed', outcome: 'late-completion' });
      await vi.waitFor(async () => expect((await runtime.getRun(runId))?.status).toBe('cancelled'));
      const events = await runtime.getRunEvents(runId, { limit: 100 });
      expect(events.items.filter(({ type }) => type === 'runCommand.accepted')).toHaveLength(1);
      expect(events.items.some(({ type }) => (type as string) === 'run.cancelled')).toBe(false);
      if (providerScopeId === undefined) {
        throw new Error('Provider scope was not observed.');
      }
      const scopeSteps = await loadAllWorkflowSteps(scopeWorkflowId(providerScopeId));
      const receives = scopeSteps.filter(({ name }) => name === 'DBOS.recv');
      const healthDeadlines = scopeSteps.filter(
        ({ name, output, startedAtEpochMs }) =>
          name === 'DBOS.sleep' &&
          typeof output === 'number' &&
          startedAtEpochMs !== undefined &&
          output === startedAtEpochMs + orphanHealthCheckSeconds * 1_000,
      );
      const healthReceiveFunctionIds = new Set(
        healthDeadlines.map(({ functionID }) => functionID - 1),
      );
      const durableReceives = receives.filter(({ functionID }) =>
        healthReceiveFunctionIds.has(functionID),
      );
      const directiveDrains = receives.filter(
        ({ functionID }) => !healthReceiveFunctionIds.has(functionID),
      );
      expect(durableReceives.every(({ output }) => output !== null)).toBe(true);
      expect(healthDeadlines).toHaveLength(durableReceives.length);
      expect(directiveDrains.map(({ output }) => output)).toStrictEqual([
        null,
        null,
        null,
        { kind: 'cancel' },
        null,
      ]);

      const failedRunId = `command-late-failure-${randomUUID()}`;
      providerStarted = false;
      providerAborted = false;
      settleProvider = undefined;
      await runtime.startRun(
        failedRunId,
        executionPlan(sequence(task('work'), end('succeeded')), {
          bindings: [agentBinding('work', 'developer')],
        }),
        null,
      );
      await vi.waitFor(() => expect(providerStarted).toBe(true));
      await expect(
        runtime.cancelRun({ runId: failedRunId, actorId: 'late-failure-operator' }),
      ).resolves.toMatchObject({ status: 'accepted' });
      await vi.waitFor(() => expect(providerAborted).toBe(true));
      settle({
        kind: 'failed',
        error: { code: 'late_provider_failure', message: 'Settled after cancellation.' },
      });
      await vi.waitFor(async () =>
        expect((await runtime.getRun(failedRunId))?.status).toBe('cancelled'),
      );
      const failedEvents = await runtime.getRunEvents(failedRunId, { limit: 100 });
      expect(failedEvents.items.map(({ type }) => type)).toStrictEqual([
        'nodeExecution.started',
        'runCommand.accepted',
      ]);
    } finally {
      settleProvider?.({ kind: 'completed', outcome: 'cleanup' });
      await runtime.stop();
    }
  }, 20_000);
});
