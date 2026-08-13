import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  CommandDispatchWorkflowInput,
  CommandDispatchWorkflowResult,
} from '../../src/contracts/workflow/run-command-workflow.js';
import type { RunWorkflowInput } from '../../src/contracts/workflow/run-workflow-input.js';
import {
  commandDispatchWorkflowName,
  commandReplyV2Topic,
  runCoordinatorV2Topic,
  runWorkflowV2Name,
} from '../../src/dbos/dbos-names.js';
import { loadAllWorkflowSteps } from '../../src/dbos/read-model/dbos-step-pages.js';
import { commandWorkflowId, runWorkflowId } from '../../src/dbos/workflow-id.js';
import { isActiveWorkflowStatus } from '../../src/dbos/workflow-status.js';
import { createCommandDispatchWorkflow } from '../../src/dbos/workflows/command-dispatch-workflow.js';
import { commandOrphanHealthCheckSeconds } from '../../src/dbos/workflows/command-dispatch-workflow.js';
import { parseRunWorkflowInput } from '../../src/validation/parse-run-workflow-data.js';
import { parseCommandDispatchInput } from '../../src/validation/run-command-workflow.validator.js';
import { parseCommandDispatchResult } from '../../src/validation/run-command-workflow.validator.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

type ReceiptResult = Extract<CommandDispatchWorkflowResult, { readonly status: 'receipt' }>;

const boundaryData = (
  durableInput: unknown,
): { readonly commandWorkflowId: string; readonly receipt: ReceiptResult } => {
  const input = parseRunWorkflowInput([durableInput]);
  const value: unknown = input.input;
  if (
    value === null ||
    typeof value !== 'object' ||
    !('commandWorkflowId' in value) ||
    typeof value.commandWorkflowId !== 'string' ||
    !('receipt' in value)
  ) {
    throw new Error('Boundary root input is invalid.');
  }
  const receipt = parseCommandDispatchResult(value.receipt);
  if (receipt.status !== 'receipt') {
    throw new Error('Boundary root receipt is invalid.');
  }
  return { commandWorkflowId: value.commandWorkflowId, receipt };
};

const rootInput = (
  runId: string,
  dispatcherWorkflowId: string,
  receipt: ReceiptResult,
): RunWorkflowInput => ({
  runId,
  admissionToken: 'a'.repeat(43),
  executionPlan: terminalExecutionPlan(),
  input: { commandWorkflowId: dispatcherWorkflowId, receipt },
});

const boundaryRoot = DBOS.registerWorkflow(
  async (durableInput: unknown) => {
    const { commandWorkflowId: replyWorkflowId, receipt } = boundaryData(durableInput);
    const command = parseCommandDispatchInput(await DBOS.recv(runCoordinatorV2Topic));
    if (command.commandId !== receipt.receipt.commandId) {
      throw new Error('Boundary root received an uncorrelated command.');
    }
    await DBOS.sleepms(1_100);
    await DBOS.send(replyWorkflowId, receipt, commandReplyV2Topic);
    return command.commandId;
  },
  { name: runWorkflowV2Name },
);

const boundaryDispatcher = DBOS.registerWorkflow(createCommandDispatchWorkflow(), {
  name: commandDispatchWorkflowName,
});

beforeAll(async () => {
  DBOS.setConfig({
    name: 'revo-run-final-drain-test',
    executorID: 'revo-run-final-drain-test',
    systemDatabaseSchemaName: 'dbos_final_drain_test',
    systemDatabaseUrl: testDatabaseUrl(),
  });
  await DBOS.launch();
});

afterAll(async () => {
  await DBOS.shutdown();
});

describe('command dispatcher terminal boundary', () => {
  it('final-drains a committed correlated reply after the first receive times out', async () => {
    const runId = `final-drain-${randomUUID()}`;
    const commandId = `cmd_${randomUUID()}` as const;
    const rootId = runWorkflowId(runId);
    const dispatcherId = commandWorkflowId(commandId);
    const input: CommandDispatchWorkflowInput = {
      commandId,
      command: { kind: 'cancelRun', input: { runId, actorId: 'operator' } },
    };
    const receipt: CommandDispatchWorkflowResult = {
      status: 'receipt',
      receipt: { status: 'accepted', commandId },
    };
    const realGetWorkflowStatus = DBOS.getWorkflowStatus.bind(DBOS);
    const terminalStatuses: string[] = [];
    let terminalObservedAt: number | undefined;
    let lookupOrdinal = 0;
    const statusSpy = vi.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async (workflowId) => {
      if (workflowId === rootId) {
        lookupOrdinal += 1;
        if (lookupOrdinal === 2) {
          // The first one-second receive has timed out. Give the root enough durable time to
          // commit its reply and terminal status before the dispatcher performs its lookup.
          await DBOS.sleepms(1_000);
        }
      }
      const status = await realGetWorkflowStatus(workflowId);
      if (workflowId === rootId && lookupOrdinal === 2 && status !== null) {
        terminalStatuses.push(status.status);
        terminalObservedAt = Date.now();
      }
      return status;
    });

    try {
      const root = await DBOS.startWorkflow(boundaryRoot, { workflowID: rootId })(
        rootInput(runId, dispatcherId, receipt),
      );
      const dispatcher = await DBOS.startWorkflow(boundaryDispatcher, {
        workflowID: dispatcherId,
      })(input);

      await expect(dispatcher.getResult()).resolves.toStrictEqual(receipt);
      await expect(root.getResult()).resolves.toBe(commandId);
      expect(lookupOrdinal).toBe(2);
      expect(terminalStatuses).toHaveLength(1);
      expect(isActiveWorkflowStatus(terminalStatuses[0] ?? '')).toBe(false);
      if (terminalObservedAt === undefined) {
        throw new Error('Dispatcher did not observe the terminal root status.');
      }

      const receives = (await loadAllWorkflowSteps(dispatcherId)).filter(
        ({ name }) => name === 'DBOS.recv',
      );
      expect(receives).toHaveLength(2);
      expect(receives[0]?.output).toBeNull();
      expect(receives[1]?.output).toStrictEqual(receipt);
      expect(receives[1]?.output).toMatchObject({ receipt: { commandId } });
      expect(receives[1]?.startedAtEpochMs).toBeGreaterThanOrEqual(terminalObservedAt);
    } finally {
      statusSpy.mockRestore();
    }
  }, 15_000);

  it('moves from the one-second race window to one notification-first orphan check', async () => {
    const runId = `notification-first-${randomUUID()}`;
    const commandId = `cmd_${randomUUID()}` as const;
    const rootId = runWorkflowId(runId);
    const dispatcherId = commandWorkflowId(commandId);
    const input: CommandDispatchWorkflowInput = {
      commandId,
      command: { kind: 'cancelRun', input: { runId, actorId: 'operator' } },
    };
    const receipt: CommandDispatchWorkflowResult = {
      status: 'receipt',
      receipt: { status: 'accepted', commandId },
    };
    const realReceive = DBOS.recv.bind(DBOS);
    const replyTimeouts: number[] = [];
    const receiveSpy = vi.spyOn(DBOS, 'recv').mockImplementation(async (topic, options) => {
      if (topic === commandReplyV2Topic) {
        replyTimeouts.push(typeof options === 'number' ? options : (options?.timeoutSeconds ?? -1));
      }
      return realReceive(topic, options);
    });

    try {
      const root = await DBOS.startWorkflow(boundaryRoot, { workflowID: rootId })(
        rootInput(runId, dispatcherId, receipt),
      );
      const startedAt = Date.now();
      const dispatcher = await DBOS.startWorkflow(boundaryDispatcher, {
        workflowID: dispatcherId,
      })(input);

      await expect(dispatcher.getResult()).resolves.toStrictEqual(receipt);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await expect(root.getResult()).resolves.toBe(commandId);
      expect(replyTimeouts).toStrictEqual([1, commandOrphanHealthCheckSeconds]);

      const receives = (await loadAllWorkflowSteps(dispatcherId)).filter(
        ({ name }) => name === 'DBOS.recv',
      );
      expect(receives).toHaveLength(2);
      expect(receives.map(({ output }) => output)).toStrictEqual([null, receipt]);
    } finally {
      receiveSpy.mockRestore();
    }
  }, 15_000);
});
