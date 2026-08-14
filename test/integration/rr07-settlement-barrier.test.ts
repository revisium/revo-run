import { randomBytes, randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CommandDispatchWorkflowInput } from '../../src/contracts/workflow/run-command-workflow.js';
import type { RunWorkflowInput } from '../../src/contracts/workflow/run-workflow-input.js';
import { RunCoordinatorClient } from '../../src/dbos/coordination/run-coordinator-client.js';
import { RunWorkflowCoordinator } from '../../src/dbos/coordination/run-workflow-coordinator.js';
import { ScopeCancellationRegistry } from '../../src/dbos/coordination/scope-cancellation-registry.js';
import {
  commandDispatchWorkflowName,
  runCoordinatorTopic,
  runWorkflowName,
  scopeDirectiveTopic,
  scopeSettlementTopic,
} from '../../src/dbos/dbos-names.js';
import { ProviderCallRegistry } from '../../src/dbos/executor/provider-call-registry.js';
import { loadAllWorkflowSteps } from '../../src/dbos/read-model/dbos-step-pages.js';
import { DbosRunEventStream } from '../../src/dbos/streams/run-event-stream.js';
import {
  commandWorkflowId,
  runWorkflowId,
  scopeWorkflowId as workflowIdForScope,
} from '../../src/dbos/workflow-id.js';
import { createCommandDispatchWorkflow } from '../../src/dbos/workflows/command-dispatch-workflow.js';
import { parseRunWorkflowInput } from '../../src/validation/parse-run-workflow-data.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

interface SettlementScopeInput {
  readonly runId: string;
  readonly rootWorkflowId: string;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
};

let scopeReturned = false;

const settlementScope = DBOS.registerWorkflow(
  async ({ runId, rootWorkflowId }: SettlementScopeInput) => {
    const client = new RunCoordinatorClient(runId);
    await client.ready(rootWorkflowId);
    await client.scopeSettled();
    const strandedDirective = await DBOS.recv(scopeDirectiveTopic, { timeoutSeconds: 0 });
    const strandedAcknowledgement = await DBOS.recv(scopeSettlementTopic, {
      timeoutSeconds: 0,
    });
    scopeReturned = true;
    return {
      status: 'failed' as const,
      outcome: 'scope-completed',
      strandedDirective,
      strandedAcknowledgement,
    };
  },
  { name: 'revo-run.rr07-settlement-barrier-scope' },
);

const scopeIdFromInput = (durableInput: unknown): string => {
  const input = parseRunWorkflowInput([durableInput]);
  const value: unknown = input.input;
  if (
    value === null ||
    typeof value !== 'object' ||
    !('scopeId' in value) ||
    typeof value.scopeId !== 'string'
  ) {
    throw new Error('Settlement-barrier root input is invalid.');
  }
  return value.scopeId;
};

const settlementBarrierRoot = DBOS.registerWorkflow(
  async (durableInput: unknown) => {
    const input = parseRunWorkflowInput([durableInput]);
    const scopeWorkflowId = workflowIdForScope(scopeIdFromInput(durableInput));
    const events = new DbosRunEventStream(input.runId);
    const coordinator = new RunWorkflowCoordinator(
      input.runId,
      events,
      input.executionPlan.policies.maximumTotalNodeExecutions,
      new ScopeCancellationRegistry(),
      new ProviderCallRegistry(),
    );
    coordinator.registerRootScope(scopeWorkflowId);
    try {
      const scope = await DBOS.startWorkflow(settlementScope, { workflowID: scopeWorkflowId })({
        runId: input.runId,
        rootWorkflowId: runWorkflowId(input.runId),
      });
      const coordinated = await coordinator.execute(scope);
      return { coordinated, scope: await scope.getResult() };
    } finally {
      await events.close();
    }
  },
  { name: runWorkflowName },
);

const commandDispatcher = DBOS.registerWorkflow(createCommandDispatchWorkflow(), {
  name: commandDispatchWorkflowName,
});

const rootInput = (runId: string, scopeId: string): RunWorkflowInput => ({
  runId,
  admissionToken: randomBytes(32).toString('base64url'),
  executionPlan: terminalExecutionPlan(),
  input: { scopeId },
});

beforeAll(async () => {
  DBOS.setConfig({
    name: 'revo-run-rr07-settlement-barrier-test',
    executorID: 'revo-run-rr07-settlement-barrier-test',
    systemDatabaseSchemaName: 'dbos_rr07_settlement_barrier_test',
    systemDatabaseUrl: testDatabaseUrl(),
  });
  await DBOS.launch();
});

afterAll(async () => {
  await DBOS.shutdown();
});

describe('RR-07 terminal settlement barrier', () => {
  it('drains a cancellation committed before the root processes settlement', async () => {
    const runId = `settlement-cancel-first-${randomUUID()}`;
    const scopeId = `sc1_${randomBytes(32).toString('base64url')}`;
    const scopeWorkflowId = workflowIdForScope(scopeId);
    const settlementAttempted = deferred();
    const releaseSettlement = deferred();
    const send = DBOS.send.bind(DBOS);
    const sendSpy = vi
      .spyOn(DBOS, 'send')
      .mockImplementation(async (workflowId, message, topic) => {
        if (
          topic === runCoordinatorTopic &&
          message !== null &&
          typeof message === 'object' &&
          'kind' in message &&
          message.kind === 'scopeSettled' &&
          'workflowId' in message &&
          message.workflowId === scopeWorkflowId
        ) {
          settlementAttempted.resolve();
          await releaseSettlement.promise;
        }
        return send(workflowId, message, topic);
      });

    try {
      const root = await DBOS.startWorkflow(settlementBarrierRoot, {
        workflowID: runWorkflowId(runId),
      })(rootInput(runId, scopeId));
      await settlementAttempted.promise;

      const commandId = `cmd_${randomUUID()}` as const;
      const command: CommandDispatchWorkflowInput = {
        commandId,
        command: { kind: 'cancelRun', input: { runId, actorId: 'operator' } },
      };
      const dispatcher = await DBOS.startWorkflow(commandDispatcher, {
        workflowID: commandWorkflowId(commandId),
      })(command);
      await expect(dispatcher.getResult()).resolves.toStrictEqual({
        status: 'receipt',
        receipt: { status: 'accepted', commandId },
      });
      releaseSettlement.resolve();

      await expect(root.getResult()).resolves.toStrictEqual({
        coordinated: { status: 'cancelled', outcome: 'cancelled' },
        scope: {
          status: 'failed',
          outcome: 'scope-completed',
          strandedDirective: null,
          strandedAcknowledgement: null,
        },
      });
    } finally {
      releaseSettlement.resolve();
      sendSpy.mockRestore();
    }
  }, 15_000);

  it('waits for delayed root settlement processing and excludes a later command', async () => {
    scopeReturned = false;
    const runId = `settlement-first-${randomUUID()}`;
    const scopeId = `sc1_${randomBytes(32).toString('base64url')}`;
    const scopeWorkflowId = workflowIdForScope(scopeId);
    const settlementDequeued = deferred();
    const releaseSettlementProcessing = deferred();
    const receive = DBOS.recv.bind(DBOS);
    const receiveSpy = vi.spyOn(DBOS, 'recv').mockImplementation(async (topic, options) => {
      const value = await receive(topic, options);
      if (
        topic === runCoordinatorTopic &&
        value !== null &&
        typeof value === 'object' &&
        'kind' in value &&
        value.kind === 'scopeSettled' &&
        'workflowId' in value &&
        value.workflowId === scopeWorkflowId
      ) {
        settlementDequeued.resolve();
        await releaseSettlementProcessing.promise;
      }
      return value;
    });

    try {
      const root = await DBOS.startWorkflow(settlementBarrierRoot, {
        workflowID: runWorkflowId(runId),
      })(rootInput(runId, scopeId));
      await settlementDequeued.promise;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(scopeReturned).toBe(false);

      releaseSettlementProcessing.resolve();
      await expect(root.getResult()).resolves.toMatchObject({
        coordinated: { status: 'failed', outcome: 'scope-completed' },
        scope: { strandedDirective: null, strandedAcknowledgement: null },
      });

      const commandId = `cmd_${randomUUID()}` as const;
      const dispatcher = await DBOS.startWorkflow(commandDispatcher, {
        workflowID: commandWorkflowId(commandId),
      })({
        commandId,
        command: { kind: 'cancelRun', input: { runId, actorId: 'late-operator' } },
      });
      await expect(dispatcher.getResult()).resolves.toMatchObject({
        status: 'receipt',
        receipt: { status: 'rejected', reason: 'run_already_terminal' },
      });
    } finally {
      releaseSettlementProcessing.resolve();
      receiveSpy.mockRestore();
    }
  }, 15_000);

  it('preserves root settlement before a malformed post-ack terminal directive rejects the scope', async () => {
    const runId = `settlement-malformed-directive-${randomUUID()}`;
    const rootWorkflowId = runWorkflowId(runId);
    const scopeId = `sc1_${randomBytes(32).toString('base64url')}`;
    const scopeWorkflowId = workflowIdForScope(scopeId);
    const malformedCommitted = deferred();
    const send = DBOS.send.bind(DBOS);
    const receive = DBOS.recv.bind(DBOS);
    const sendSpy = vi
      .spyOn(DBOS, 'send')
      .mockImplementation(async (workflowId, message, topic) => {
        const result = await send(workflowId, message, topic);
        if (workflowId === scopeWorkflowId && topic === scopeSettlementTopic) {
          await send(scopeWorkflowId, { kind: 'cancel', extra: true }, scopeDirectiveTopic);
          malformedCommitted.resolve();
        }
        return result;
      });
    const receiveSpy = vi.spyOn(DBOS, 'recv').mockImplementation(async (topic, options) => {
      const result = await receive(topic, options);
      if (topic === scopeSettlementTopic && result !== null) {
        await malformedCommitted.promise;
      }
      return result;
    });

    try {
      const root = await DBOS.startWorkflow(settlementBarrierRoot, {
        workflowID: rootWorkflowId,
      })(rootInput(runId, scopeId));

      await expect(root.getResult()).rejects.toThrow('Scope directive is invalid.');
      await expect(DBOS.retrieveWorkflow(scopeWorkflowId).getResult()).rejects.toThrow(
        'Scope directive is invalid.',
      );
      const settlementReceives = (await loadAllWorkflowSteps(rootWorkflowId)).filter(
        ({ name, output }) =>
          name === 'DBOS.recv' &&
          output !== null &&
          typeof output === 'object' &&
          'kind' in output &&
          output.kind === 'scopeSettled',
      );
      expect(settlementReceives).toHaveLength(1);
    } finally {
      malformedCommitted.resolve();
      receiveSpy.mockRestore();
      sendSpy.mockRestore();
    }
  }, 15_000);
});
