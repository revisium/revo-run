import { randomUUID } from 'node:crypto';

import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { commandDispatchWorkflowName } from '../../src/dbos/dbos-names.js';
import { DbosRunRuntime } from '../../src/dbos/dbos-run-runtime.js';
import { WorkflowRegistry } from '../../src/dbos/workflow-registry.js';
import { testDatabaseUrl } from '../support/test-environment.js';

describe('RR-07 missing-run command admission', () => {
  it('does not create a command workflow row for a missing root', async () => {
    const workflows = new WorkflowRegistry();
    const runtime = new DbosRunRuntime(
      testDatabaseUrl(),
      { execute: async () => ({ kind: 'completed', outcome: 'unused' }) },
      workflows,
    );
    const client = await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl() });
    await runtime.start();
    const runId = `missing-command-root-${randomUUID()}`;

    const commandRowsForRun = async () =>
      (
        await client.listWorkflows({
          workflowName: commandDispatchWorkflowName,
          loadInput: true,
          limit: 100,
          sortDesc: true,
        })
      ).filter(({ input }) => {
        const durableInput = input?.[0];
        if (
          typeof durableInput !== 'object' ||
          durableInput === null ||
          !('command' in durableInput)
        ) {
          return false;
        }
        const command = durableInput.command;
        return (
          typeof command === 'object' &&
          command !== null &&
          'input' in command &&
          typeof command.input === 'object' &&
          command.input !== null &&
          'runId' in command.input &&
          command.input.runId === runId
        );
      });

    try {
      await expect(runtime.cancelRun({ runId, actorId: 'operator' })).rejects.toMatchObject({
        code: 'run_not_found',
        commandId: undefined,
      });
      await expect(commandRowsForRun()).resolves.toHaveLength(0);
    } finally {
      await runtime.stop();
      await client.destroy();
    }
  }, 20_000);
});
