import { DBOS } from '@dbos-inc/dbos-sdk';

import type {
  CommandDispatchWorkflowInput,
  CommandDispatchWorkflowResult,
} from '../../contracts/workflow/run-command-workflow.js';
import { parseRunWorkflowInput } from '../../validation/parse-run-workflow-data.js';
import {
  parseCommandDispatchInput,
  parseCommandDispatchResult,
} from '../../validation/run-command-workflow.validator.js';
import { durableOperationLoop } from '../coordination/durable-operation-loop.js';
import { orphanHealthCheckSeconds } from '../coordination/orphan-health-check.js';
import { commandReplyV2Topic, runCoordinatorV2Topic, runWorkflowV2Name } from '../dbos-names.js';
import { runWorkflowId } from '../workflow-id.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';

export type CommandDispatchWorkflow = (
  input: CommandDispatchWorkflowInput,
) => Promise<CommandDispatchWorkflowResult>;

const commandRaceWindowSeconds = 1;
/** Replies wake this receive immediately; the timeout only detects an orphaned active root. */
export const commandOrphanHealthCheckSeconds = orphanHealthCheckSeconds;

const finalReply = async (): Promise<CommandDispatchWorkflowResult | undefined> => {
  const reply = await DBOS.recv(commandReplyV2Topic, { timeoutSeconds: 0 });
  return reply === null ? undefined : parseCommandDispatchResult(reply);
};

const waitForReply = async (
  input: CommandDispatchWorkflowInput,
  rootWorkflowId: string,
): Promise<CommandDispatchWorkflowResult> => {
  const receiveOrObserveTerminal = async (
    timeoutSeconds: number,
  ): Promise<CommandDispatchWorkflowResult | undefined> => {
    const reply = await DBOS.recv(commandReplyV2Topic, { timeoutSeconds });
    if (reply !== null) {
      return parseCommandDispatchResult(reply);
    }
    const latest = await DBOS.getWorkflowStatus(rootWorkflowId);
    if (latest === null || !isActiveWorkflowStatus(latest.status)) {
      const queued = await finalReply();
      return (
        queued ?? {
          status: 'receipt',
          receipt: {
            status: 'rejected',
            commandId: input.commandId,
            reason: 'run_already_terminal',
          },
        }
      );
    }
    return undefined;
  };

  const initial = await receiveOrObserveTerminal(commandRaceWindowSeconds);
  if (initial !== undefined) {
    return initial;
  }
  for await (const result of durableOperationLoop(() =>
    receiveOrObserveTerminal(commandOrphanHealthCheckSeconds),
  )) {
    if (result !== undefined) {
      return result;
    }
  }
  throw new Error('Durable command reply loop terminated unexpectedly.');
};

const isOwnedRoot = async (rootWorkflowId: string, runId: string): Promise<boolean> => {
  try {
    const durableArguments =
      await DBOS.retrieveWorkflow(rootWorkflowId).getWorkflowInputs<unknown[]>();
    return parseRunWorkflowInput(durableArguments).runId === runId;
  } catch {
    return false;
  }
};

export const createCommandDispatchWorkflow =
  (): CommandDispatchWorkflow => async (durableInput) => {
    const input = parseCommandDispatchInput(durableInput);
    const runId = 'input' in input.command ? input.command.input.runId : undefined;
    if (runId === undefined) {
      return {
        status: 'receipt',
        receipt: {
          status: 'rejected',
          commandId: input.commandId,
          reason: 'command_not_supported',
        },
      };
    }

    const rootWorkflowId = runWorkflowId(runId);
    const root = await DBOS.getWorkflowStatus(rootWorkflowId);
    if (root?.workflowName !== runWorkflowV2Name) {
      if (root?.workflowName === 'revo-run.run.v1') {
        return {
          status: 'receipt',
          receipt: {
            status: 'rejected',
            commandId: input.commandId,
            reason: 'unsupported_run_version',
          },
        };
      }
      return { status: 'runNotFound', commandId: input.commandId };
    }
    if (!(await isOwnedRoot(rootWorkflowId, runId))) {
      return { status: 'dispatchFailed', commandId: input.commandId };
    }
    if (!isActiveWorkflowStatus(root.status)) {
      return {
        status: 'receipt',
        receipt: {
          status: 'rejected',
          commandId: input.commandId,
          reason: 'run_already_terminal',
        },
      };
    }

    await DBOS.send(rootWorkflowId, input, runCoordinatorV2Topic);
    return waitForReply(input, rootWorkflowId);
  };
