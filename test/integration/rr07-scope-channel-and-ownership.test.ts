import { randomBytes, randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ParallelBranchWorkflowV2Input } from '../../src/contracts/workflow/parallel-branch-workflow-v2-input.js';
import type { CommandDispatchWorkflowInput } from '../../src/contracts/workflow/run-command-workflow.js';
import type { RunWorkflowInput } from '../../src/contracts/workflow/run-workflow-input.js';
import {
  RunCoordinatorV2Client,
  ScopeCancellationError,
} from '../../src/dbos/coordination/run-coordinator-v2-client.js';
import {
  commandDispatchWorkflowName,
  isRunCommandDecisionStepName,
  runCoordinatorV2Topic,
  runWorkflowV2Name,
  scopeDirectiveV2Topic,
  scopeReplyV2Topic,
  scopeSettlementV2Topic,
} from '../../src/dbos/dbos-names.js';
import { DbosParallelBranchRunnerV2 } from '../../src/dbos/parallel/dbos-parallel-branch-runner-v2.js';
import { loadAllWorkflowSteps } from '../../src/dbos/read-model/dbos-step-pages.js';
import { commandWorkflowId, runWorkflowId, scopeWorkflowV2Id } from '../../src/dbos/workflow-id.js';
import { createCommandDispatchWorkflow } from '../../src/dbos/workflows/command-dispatch-workflow.js';
import { ParallelBranchWorkflowV2Provider } from '../../src/dbos/workflows/parallel-branch-workflow-v2-provider.js';
import {
  createAuthoredNodeId,
  createParallelBranchScopeId,
} from '../../src/pipeline/identity/execution-identity.js';
import type { PipelineExecutionContext } from '../../src/pipeline/interpreter/interpreter-context.js';
import { parseRunWorkflowInput } from '../../src/validation/parse-run-workflow-data.js';
import { parseRunCoordinatorV2Message } from '../../src/validation/run-coordinator-v2-message.validator.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

interface ScopeProbeInput {
  readonly runId: string;
  readonly parentWorkflowId: string;
}

interface RegistrationRaceRootInput {
  readonly parentWorkflowId: string;
  readonly childWorkflowId: string;
}

interface RegistrationRaceParentInput {
  readonly runId: string;
  readonly scopeId: string;
  readonly rootWorkflowId: string;
}

const scopeWorkflowIdFromInput = (input: RunWorkflowInput): string => {
  const value: unknown = input.input;
  if (
    value === null ||
    typeof value !== 'object' ||
    !('scopeWorkflowId' in value) ||
    typeof value.scopeWorkflowId !== 'string'
  ) {
    throw new Error('Channel-test root input is missing its scope workflow ID.');
  }
  return value.scopeWorkflowId;
};

const channelOrMalformedRoot = DBOS.registerWorkflow(
  async (durableInput: unknown): Promise<unknown> => {
    let input: RunWorkflowInput;
    try {
      input = parseRunWorkflowInput([durableInput]);
    } catch {
      return DBOS.recv(runCoordinatorV2Topic, { timeoutSeconds: 1 });
    }

    const scopeWorkflowId = scopeWorkflowIdFromInput(input);
    await DBOS.send(scopeWorkflowId, { kind: 'cancel' }, scopeDirectiveV2Topic);
    const ready = parseRunCoordinatorV2Message(await DBOS.recv(runCoordinatorV2Topic));
    if (!('kind' in ready) || ready.kind !== 'scopeReady' || ready.workflowId !== scopeWorkflowId) {
      throw new Error('Channel-test root received an unexpected scope message.');
    }
    await DBOS.send(scopeWorkflowId, { kind: 'continue' }, scopeReplyV2Topic);
    return ready.kind;
  },
  { name: runWorkflowV2Name },
);

const channelScope = DBOS.registerWorkflow(
  async ({ runId, parentWorkflowId }: ScopeProbeInput) => {
    const client = new RunCoordinatorV2Client(runId);
    let result = 'continued';
    try {
      await client.ready(parentWorkflowId);
    } catch (error) {
      if (!(error instanceof ScopeCancellationError)) {
        throw error;
      }
      result = 'cancelled';
    }
    const strandedDirective = await DBOS.recv(scopeDirectiveV2Topic, { timeoutSeconds: 0 });
    const strandedReply = await DBOS.recv(scopeReplyV2Topic, { timeoutSeconds: 0 });
    return { result, strandedDirective, strandedReply };
  },
  { name: 'revo-run.rr07-channel-probe.v1' },
);

const registrationRaceChild = DBOS.registerWorkflow(
  async (input: ParallelBranchWorkflowV2Input) => {
    const client = new RunCoordinatorV2Client(input.runId);
    try {
      await client.ready(input.parentWorkflowId);
      await DBOS.runStep(async () => 'forbidden', { name: 'forbidden-provider-plan-work' });
      return {
        status: 'completed' as const,
        key: input.branchKey,
        outcome: 'forbidden',
        outputs: [],
      };
    } catch (error) {
      if (!(error instanceof ScopeCancellationError)) {
        throw error;
      }
      return { status: 'cancelled' as const, key: input.branchKey };
    } finally {
      await client.scopeSettled();
    }
  },
  { name: 'revo-run.rr07-registration-race-child.v1' },
);

const registrationRaceWorkflows = new ParallelBranchWorkflowV2Provider();
registrationRaceWorkflows.register(registrationRaceChild);

const registrationRaceParent = DBOS.registerWorkflow(
  async ({ runId, scopeId, rootWorkflowId }: RegistrationRaceParentInput) => {
    const client = new RunCoordinatorV2Client(runId);
    const context: PipelineExecutionContext = {
      plan: terminalExecutionPlan(),
      runId,
      scopeId,
      runInput: null,
      pipelineId: 'main',
      pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
      runtimePath: 'main',
      outputs: new Map(),
      maximumParallelism: 1,
    };
    try {
      await client.ready(rootWorkflowId);
      const runner = new DbosParallelBranchRunnerV2(registrationRaceWorkflows, client);
      await runner.execute(
        [
          { key: 'first', node: { kind: 'end', status: 'succeeded', outcome: 'first' } },
          { key: 'second', node: { kind: 'end', status: 'succeeded', outcome: 'second' } },
        ],
        context,
        'main/work',
      );
      return 'completed';
    } catch (error) {
      if (!(error instanceof ScopeCancellationError)) {
        throw error;
      }
      return 'cancelled';
    } finally {
      await client.scopeSettled();
    }
  },
  { name: 'revo-run.rr07-registration-race-parent.v1' },
);

const registrationRaceRoot = DBOS.registerWorkflow(
  async ({ parentWorkflowId, childWorkflowId }: RegistrationRaceRootInput) => {
    const parentReady = parseRunCoordinatorV2Message(await DBOS.recv(runCoordinatorV2Topic));
    if (
      !('kind' in parentReady) ||
      parentReady.kind !== 'scopeReady' ||
      parentReady.workflowId !== parentWorkflowId
    ) {
      throw new Error('Registration-race root expected parent readiness first.');
    }
    await DBOS.send(parentWorkflowId, { kind: 'continue' }, scopeReplyV2Topic);

    const registration = parseRunCoordinatorV2Message(await DBOS.recv(runCoordinatorV2Topic));
    if (
      !('kind' in registration) ||
      registration.kind !== 'scopeRegistered' ||
      registration.workflowId !== childWorkflowId ||
      registration.parentWorkflowId !== parentWorkflowId
    ) {
      throw new Error('Registration-race root expected child registration before readiness.');
    }
    await DBOS.send(parentWorkflowId, { kind: 'continue' }, scopeReplyV2Topic);
    await DBOS.send(parentWorkflowId, { kind: 'cancel' }, scopeDirectiveV2Topic);

    const receiveRemaining = async (
      settled: ReadonlySet<string>,
      childReadyFenced: boolean,
    ): Promise<{ readonly childReadyFenced: boolean; readonly settled: ReadonlySet<string> }> => {
      if (settled.size >= 2) {
        return { childReadyFenced, settled };
      }
      const value = await DBOS.recv(runCoordinatorV2Topic, { timeoutSeconds: 2 });
      if (value === null) {
        return { childReadyFenced, settled };
      }
      const message = parseRunCoordinatorV2Message(value);
      if ('kind' in message && message.kind === 'scopeReady') {
        if (message.workflowId !== childWorkflowId) {
          throw new Error('Registration-race root received readiness from another child.');
        }
        await DBOS.send(childWorkflowId, { kind: 'cancel' }, scopeReplyV2Topic);
        return receiveRemaining(settled, true);
      }
      if ('kind' in message && message.kind === 'scopeSettled') {
        await DBOS.send(message.workflowId, { kind: 'settled' }, scopeSettlementV2Topic);
        return receiveRemaining(new Set([...settled, message.workflowId]), childReadyFenced);
      }
      throw new Error('Registration-race root received an unexpected scope message.');
    };
    const result = await receiveRemaining(new Set(), false);
    return { childReadyFenced: result.childReadyFenced, settled: [...result.settled].sort() };
  },
  { name: 'revo-run.rr07-registration-race-root.v1' },
);

const commandDispatcher = DBOS.registerWorkflow(createCommandDispatchWorkflow(), {
  name: commandDispatchWorkflowName,
});

beforeAll(async () => {
  DBOS.setConfig({
    name: 'revo-run-rr07-channel-ownership-test',
    executorID: 'revo-run-rr07-channel-ownership-test',
    systemDatabaseSchemaName: 'dbos_rr07_channel_ownership_test',
    systemDatabaseUrl: testDatabaseUrl(),
  });
  await DBOS.launch();
});

afterAll(async () => {
  await DBOS.shutdown();
});

describe('RR-07 durable scope channels and root ownership', () => {
  it('consumes the correlated reply before the earlier asynchronous directive without stranding either', async () => {
    const runId = `scope-channel-${randomUUID()}`;
    const rootWorkflowId = runWorkflowId(runId);
    const scopeWorkflowId = scopeWorkflowV2Id(`sc1_${randomBytes(32).toString('base64url')}`);
    const rootInput: RunWorkflowInput = {
      runId,
      admissionToken: randomBytes(32).toString('base64url'),
      executionPlan: terminalExecutionPlan(),
      input: { scopeWorkflowId },
    };

    const root = await DBOS.startWorkflow(channelOrMalformedRoot, {
      workflowID: rootWorkflowId,
    })(rootInput);
    const scope = await DBOS.startWorkflow(channelScope, { workflowID: scopeWorkflowId })({
      runId,
      parentWorkflowId: rootWorkflowId,
    });

    await expect(scope.getResult()).resolves.toStrictEqual({
      result: 'cancelled',
      strandedDirective: null,
      strandedReply: null,
    });
    await expect(root.getResult()).resolves.toBe('scopeReady');

    const receives = (await loadAllWorkflowSteps(scopeWorkflowId)).filter(
      ({ name }) => name === 'DBOS.recv',
    );
    expect(receives.map(({ output }) => output)).toStrictEqual([
      { kind: 'continue' },
      { kind: 'cancel' },
      null,
      null,
    ]);
  });

  it('fails a malformed active v2 root before sending a command or recording a decision', async () => {
    const runId = `malformed-root-${randomUUID()}`;
    const commandId = `cmd_${randomUUID()}` as const;
    const rootWorkflowId = runWorkflowId(runId);
    const dispatcherWorkflowId = commandWorkflowId(commandId);
    const command: CommandDispatchWorkflowInput = {
      commandId,
      command: { kind: 'cancelRun', input: { runId, actorId: 'operator' } },
    };

    const root = await DBOS.startWorkflow(channelOrMalformedRoot, {
      workflowID: rootWorkflowId,
    })({ runId });
    const dispatcher = await DBOS.startWorkflow(commandDispatcher, {
      workflowID: dispatcherWorkflowId,
    })(command);

    await expect(dispatcher.getResult()).resolves.toStrictEqual({
      status: 'dispatchFailed',
      commandId,
    });
    await expect(root.getResult()).resolves.toBeNull();

    const dispatcherSteps = await loadAllWorkflowSteps(dispatcherWorkflowId);
    expect(dispatcherSteps.some(({ name }) => name === 'DBOS.send')).toBe(false);
    expect(dispatcherSteps.some(({ name }) => isRunCommandDecisionStepName(name))).toBe(false);
  });

  it('starts and recursively fences a registered child before the parent drains cancellation', async () => {
    const runId = `registration-race-${randomUUID()}`;
    const rootWorkflowId = runWorkflowId(runId);
    const parentScopeId = `sc1_${randomBytes(32).toString('base64url')}`;
    const parentWorkflowId = scopeWorkflowV2Id(parentScopeId);
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: 1,
      pipelineId: 'main',
      nodePath: 'main/work',
      nodeKind: 'parallel',
    });
    const firstChildWorkflowId = scopeWorkflowV2Id(
      createParallelBranchScopeId({
        parentScopeId,
        authoredNodeId,
        branchKey: 'first',
      }),
    );
    const secondChildWorkflowId = scopeWorkflowV2Id(
      createParallelBranchScopeId({
        parentScopeId,
        authoredNodeId,
        branchKey: 'second',
      }),
    );

    const root = await DBOS.startWorkflow(registrationRaceRoot, {
      workflowID: rootWorkflowId,
    })({ parentWorkflowId, childWorkflowId: firstChildWorkflowId });
    const parent = await DBOS.startWorkflow(registrationRaceParent, {
      workflowID: parentWorkflowId,
    })({ runId, scopeId: parentScopeId, rootWorkflowId });

    await expect(parent.getResult()).resolves.toBe('cancelled');
    await expect(root.getResult()).resolves.toStrictEqual({
      childReadyFenced: true,
      settled: [firstChildWorkflowId, parentWorkflowId].sort(),
    });
    await expect(DBOS.retrieveWorkflow(firstChildWorkflowId).getResult()).resolves.toStrictEqual({
      status: 'cancelled',
      key: 'first',
    });
    await expect(DBOS.getWorkflowStatus(secondChildWorkflowId)).resolves.toBeNull();

    const childSteps = await loadAllWorkflowSteps(firstChildWorkflowId);
    expect(childSteps[0]?.name).toBe('DBOS.send');
    expect(childSteps.some(({ name }) => name === 'forbidden-provider-plan-work')).toBe(false);
  }, 10_000);
});
