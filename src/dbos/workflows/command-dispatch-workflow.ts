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
import { commandReplyTopic, runCoordinatorTopic, runWorkflowName } from '../dbos-names.js';
import { runWorkflowId } from '../workflow-id.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';

export type CommandDispatchWorkflow = (
  input: CommandDispatchWorkflowInput,
) => Promise<CommandDispatchWorkflowResult>;

const commandRaceWindowSeconds = 1;

const finalReply = async (): Promise<CommandDispatchWorkflowResult | undefined> => {
  const reply = await DBOS.recv(commandReplyTopic, { timeoutSeconds: 0 });
  return reply === null ? undefined : parseCommandDispatchResult(reply);
};

const waitForReply = async (
  input: CommandDispatchWorkflowInput,
  rootWorkflowId: string,
): Promise<CommandDispatchWorkflowResult> => {
  const receiveOrObserveTerminal = async (
    timeoutSeconds: number,
  ): Promise<CommandDispatchWorkflowResult | undefined> => {
    const reply = await DBOS.recv(commandReplyTopic, { timeoutSeconds });
    if (reply !== null) {
      return parseCommandDispatchResult(reply);
    }
    const latest = await DBOS.getWorkflowStatus(rootWorkflowId);
    if (latest === null || !isActiveWorkflowStatus(latest.status)) {
      return (
        (await finalReply()) ?? {
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
    receiveOrObserveTerminal(orphanHealthCheckSeconds),
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
    if (root?.workflowName !== runWorkflowName) {
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
    await DBOS.send(rootWorkflowId, input, runCoordinatorTopic);
    return waitForReply(input, rootWorkflowId);
  };
