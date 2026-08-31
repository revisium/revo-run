import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  compilePipeline,
  type PipelineSelections,
  type PipelineSourcePackage,
} from '@revisium/revo-pipeline';
import { createInitialPipelineState } from '@revisium/revo-pipeline/kernel';
import { createRevoScripts } from '@revisium/revo-scripts';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimePort,
  AgentRuntimeStartInput,
  AgentStartOutcome,
  AgentTerminalResult,
  PreparedAgentBinding,
} from '../../src/composition/agent-port.js';
import { unavailableAgentPort } from '../../src/composition/agent-port.js';
import { RunHostReadinessFence } from '../../src/composition/readiness-fence.js';
import {
  clearRunComposition,
  installRunComposition,
  type RunComposition,
} from '../../src/composition/run-composition.js';
import type { AdmittedRunSnapshotV1 } from '../../src/contracts/admitted-run.js';
import { isJsonObject } from '../../src/contracts/json.js';
import type { KernelRunResult } from '../../src/dbos/kernel-run-workflow.js';
import { kernelRunWorkflow } from '../../src/dbos/kernel-run-workflow.js';
import { coordinatorTopic } from '../../src/dbos/operation-workflow.js';
import { operationWorkflowId, runWorkflowId } from '../../src/dbos/workflow-id.js';
import { attemptId, operationId, operationReceiptId } from '../../src/operations/identities.js';
import { createFakeAgentPort } from '../support/agent-runtime/fake-agent-port.js';
import { codexContextCase } from '../support/codex-conformance.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const agentInputSchema = {
  type: 'object' as const,
  properties: { prompt: { type: 'string' as const, enum: ['Review the change.'] } },
  required: ['prompt'],
  additionalProperties: false as const,
};

const agentOutputSchema = {
  type: 'object' as const,
  properties: { decision: { type: 'string' as const, enum: ['approved'] } },
  required: ['decision'],
  additionalProperties: false as const,
};

const singleAgentPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-private-agent-single',
  entryModule: 'main',
  maximumTotalActivities: 1,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'review',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'agent',
            id: 'review',
            strategies: [
              { kind: 'single', routes: { succeeded: 'done', failed: 'done', cancelled: 'done' } },
            ],
            input: { prompt: { kind: 'literal', value: 'Review the change.' } },
            inputSchema: agentInputSchema,
            outputSchema: agentOutputSchema,
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const consensusPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-private-agent-consensus',
  entryModule: 'main',
  maximumTotalActivities: 3,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'consensus',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'consensus',
            id: 'consensus',
            participants: [
              {
                key: 'analyst',
                bindingKey: 'analyst',
                input: { prompt: { kind: 'literal', value: 'Vote.' } },
                inputSchema: {
                  ...agentInputSchema,
                  properties: { prompt: { type: 'string', enum: ['Vote.'] } },
                },
              },
              {
                key: 'reviewer',
                bindingKey: 'reviewer',
                input: { prompt: { kind: 'literal', value: 'Vote.' } },
                inputSchema: {
                  ...agentInputSchema,
                  properties: { prompt: { type: 'string', enum: ['Vote.'] } },
                },
              },
              {
                key: 'arbiter',
                bindingKey: 'arbiter',
                input: { prompt: { kind: 'literal', value: 'Vote.' } },
                inputSchema: {
                  ...agentInputSchema,
                  properties: { prompt: { type: 'string', enum: ['Vote.'] } },
                },
              },
            ],
            policy: { kind: 'unanimous' },
            remaining: 'drain',
            routes: {
              approved: 'done',
              rejected: 'done',
              inconclusive: 'done',
              participantFailed: 'done',
              cancelled: 'done',
            },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const bindingFor = (agentId: string): PreparedAgentBinding => ({
  schemaVersion: 'prepared-agent-binding/v1',
  pin: {
    agentId,
    agentVersion: '1.0.0',
    definitionDigest: `sha256:${agentId.padEnd(64, '0').slice(0, 64)}`,
  },
  parameters: {},
  permissions: {},
  workspaceRef: `/trusted/${agentId}`,
});

const succeededResult = (
  input: AgentRuntimeStartInput,
  pin: PreparedAgentBinding['pin'],
  value: Readonly<Record<string, string>>,
): AgentTerminalResult => ({
  schemaVersion: 'agent-terminal-result/v1',
  invocationId: input.invocationId,
  pin,
  status: 'succeeded',
  value,
});

const cancelledResult = (
  input: AgentRuntimeStartInput,
  pin: PreparedAgentBinding['pin'],
): AgentTerminalResult => ({
  schemaVersion: 'agent-terminal-result/v1',
  invocationId: input.invocationId,
  pin,
  status: 'cancelled',
});

const hostileTerminalAgentResult = (
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
  invocationId: string,
): AgentTerminalResult => {
  const common = {
    schemaVersion: 'agent-terminal-result/v1' as const,
    invocationId,
    pin: bindingFor('reviewer').pin,
  };
  if (status === 'succeeded') {
    return {
      ...common,
      status,
      value: { decision: 'approved' },
    };
  }
  if (status === 'cancelled') {
    return { ...common, status };
  }
  return {
    ...common,
    status,
    error: {
      code: status === 'timed_out' ? 'revo.agent.timeout' : 'revo.agent.internal',
      message: status === 'timed_out' ? 'Timed out.' : 'Failed.',
    },
  };
};

let composition: RunComposition | undefined;

afterEach(async () => {
  await DBOS.shutdown().catch(() => undefined);
  if (composition !== undefined) {
    clearRunComposition(composition);
  }
  composition = undefined;
});

const runKnownAgentSnapshot = async (
  pipeline: PipelineSourcePackage,
  selections: PipelineSelections,
  output: Readonly<Record<string, string>>,
  useUnavailablePort = false,
  resultFor?: (input: AgentRuntimeStartInput) => AgentTerminalResult,
  deferCompletionUntilCancel = false,
  afterWorkflowStart?: (runId: string) => Promise<void>,
  runIdOverride?: string,
  agentPortOverride?: AgentRuntimePort,
  reuseLaunchedDbos = false,
): Promise<{
  readonly result: KernelRunResult;
  readonly starts: readonly { readonly invocationId: string; readonly prompt: string }[];
  readonly cancellations: readonly string[];
}> => {
  const fake = createFakeAgentPort(
    (input) => resultFor?.(input) ?? succeededResult(input, input.binding.pin, output),
    { deferCompletionUntilCancel },
  );
  const fence = new RunHostReadinessFence();
  fence.open();
  composition = {
    fence,
    agents: useUnavailablePort ? unavailableAgentPort : (agentPortOverride ?? fake.port),
    scripts: createRevoScripts({
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Private agent fixture must not acquire a script workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Private agent fixture must not acquire a script credential.');
          },
        },
      },
    }),
  };
  installRunComposition(composition);
  if (!reuseLaunchedDbos) {
    DBOS.setConfig({ name: 'revo-run-private-agent-test', systemDatabaseUrl: testDatabaseUrl() });
    await DBOS.launch();
  }
  const compilation = compilePipeline(pipeline, selections);
  if (!compilation.ok) {
    throw new Error(`Agent fixture did not compile: ${JSON.stringify(compilation.diagnostics)}`);
  }
  const initial = createInitialPipelineState(
    { program: compilation.program, programDigest: compilation.programDigest },
    {},
  );
  if (initial.state.status === 'failed') {
    throw new Error('Agent fixture did not create an initial state.');
  }
  const runId = runIdOverride ?? `rn1-private-agent-${randomUUID()}`;
  const bindings = Object.fromEntries(
    compilation.requirements.entries.flatMap((requirement) =>
      requirement.kind === 'agent'
        ? [[requirement.bindingKey, bindingFor(requirement.bindingKey)]]
        : [],
    ),
  );
  const assignments = Object.fromEntries(
    compilation.requirements.entries.flatMap((requirement) =>
      requirement.kind === 'agent'
        ? [
            [
              requirement.bindingKey,
              {
                definition: { id: requirement.bindingKey, version: '1.0.0' },
                parameters: {},
                permissions: {},
                workspaceRef: 'private-agent-fixture',
              },
            ],
          ]
        : [],
    ),
  );
  const snapshot: AdmittedRunSnapshotV1 = {
    persistenceVersion: 1,
    runId,
    raw: {
      pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections,
        bindings: {
          agents: assignments,
          scripts: {},
        },
      },
      input: {},
    },
    compilation: {
      program: compilation.program,
      requirements: compilation.requirements,
      provenance: compilation.provenance,
      sourceDigest: compilation.sourceDigest,
      materializationDigest: compilation.materializationDigest,
      programDigest: compilation.programDigest,
    },
    bindings: { scripts: {}, agents: bindings },
    initial: { state: initial.state, commands: initial.commands },
    admission: { createdAt: new Date().toISOString(), token: randomUUID() },
  };
  await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: runWorkflowId(runId) })(snapshot);
  await afterWorkflowStart?.(runId);
  const result = await DBOS.retrieveWorkflow<KernelRunResult>(runWorkflowId(runId)).getResult();
  return { result, starts: fake.starts, cancellations: fake.cancellations };
};

const classificationPort = (
  variant: string,
  startCalls: AgentRuntimeStartInput[],
): AgentRuntimePort => {
  let acceptedInput: AgentRuntimeStartInput | undefined;
  const terminal = (
    input: AgentRuntimeStartInput,
    status: 'failed' | 'cancelled',
  ): AgentTerminalResult =>
    status === 'cancelled'
      ? cancelledResult(input, input.binding.pin)
      : {
          schemaVersion: 'agent-terminal-result/v1',
          invocationId: input.invocationId,
          pin: input.binding.pin,
          status: 'failed',
          error: { code: 'revo.run.execution_failed', message: 'Agent execution failed.' },
        };
  const start = async (input: AgentRuntimeStartInput): Promise<AgentStartOutcome> => {
    startCalls.push(input);
    acceptedInput = input;
    if (variant === 'known-agent-manager-rejection') {
      return { status: 'rejected', result: terminal(input, 'failed') };
    }
    if (variant === 'preaccept-abort') {
      return { status: 'rejected', result: terminal(input, 'cancelled') };
    }
    if (variant === 'unexpected-runtime-start-throw') {
      throw new Error('unexpected runtime start fault');
    }
    const mismatch = variant === 'mismatched-handle';
    const result = succeededResult(input, input.binding.pin, { decision: 'approved' });
    return {
      status: 'accepted',
      handle: {
        invocationId: mismatch ? `${input.invocationId}-mismatch` : input.invocationId,
        pin: input.binding.pin,
        result: async () => result,
        cancel: async () => ({ state: 'already_completed', result }),
      },
    };
  };
  return {
    initialize: async () => undefined,
    prepareBinding: async () => {
      throw new Error('Classification fixture does not prepare bindings.');
    },
    start,
    getResult: (invocationId) => {
      if (variant !== 'mismatched-lookup' || acceptedInput === undefined) {
        return { state: 'unknown' };
      }
      return {
        state: 'completed',
        result: succeededResult(
          { ...acceptedInput, invocationId: `${invocationId}-mismatch` },
          acceptedInput.binding.pin,
          { decision: 'approved' },
        ),
      };
    },
    cancel: async () => ({ state: 'unknown' }),
    shutdown: async () => undefined,
  };
};

describe('RN1 private agent-runtime port', () => {
  it('CTX-START-CLASSIFICATION executes every start outcome without replacement', async () => {
    const context = await codexContextCase('CTX-START-CLASSIFICATION');
    if (
      !isJsonObject(context.input) ||
      !Array.isArray(context.input.variants) ||
      !context.input.variants.every((variant) => typeof variant === 'string')
    ) {
      throw new Error('CTX-START-CLASSIFICATION has invalid input.');
    }
    const inputVariants = context.input.variants;
    const statuses: string[] = [];
    let totalStartCalls = 0;
    for (const [variantIndex, variant] of inputVariants.entries()) {
      const starts: AgentRuntimeStartInput[] = [];
      let result: KernelRunResult | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- the vector fixes durable variant order.
        ({ result } = await runKnownAgentSnapshot(
          singleAgentPipeline,
          {
            review: {
              strategy: 'single',
              participant: { key: 'reviewer', bindingKey: 'reviewer' },
            },
          },
          { decision: 'approved' },
          false,
          undefined,
          false,
          undefined,
          `rn1-start-classification-${variant}-${randomUUID()}`,
          classificationPort(variant, starts),
          variantIndex > 0,
        ));
      } finally {
        if (composition !== undefined) {
          clearRunComposition(composition);
        }
        composition = undefined;
      }
      if (result === undefined) {
        throw new Error(`Start classification variant ${variant} produced no result.`);
      }
      totalStartCalls += starts.length;
      statuses.push(result.details.activities[0]?.status ?? 'missing');
    }

    expect({
      statuses,
      replacementInvocationCalls: totalStartCalls - inputVariants.length,
    }).toStrictEqual(context.expected);
  });

  it('keeps the production unavailable port side-effect free only for initialize([])', async () => {
    await expect(unavailableAgentPort.initialize([])).resolves.toBeUndefined();
    await expect(
      unavailableAgentPort.initialize([
        {
          invocationId: 'att_1',
          pin: { agentId: 'agent', agentVersion: '1', definitionDigest: 'sha256:1' },
          state: 'running',
          process: {
            pid: 1,
            processGroupId: 1,
            fingerprint: 'test',
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ]),
    ).rejects.toMatchObject({ code: 'agent_runtime_unavailable', details: {} });
  });

  it('hosts a known-v1 agent snapshot through PL1 commands without exposing an agent manager option', async () => {
    const { result, starts } = await runKnownAgentSnapshot(
      singleAgentPipeline,
      { review: { strategy: 'single', participant: { key: 'reviewer', bindingKey: 'reviewer' } } },
      { decision: 'approved' },
    );

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ prompt: 'Review the change.' });
    expect(result.snapshot).toMatchObject({
      status: 'succeeded',
      terminal: { kind: 'succeeded', outcome: 'ok', output: {} },
    });
    expect(result.details.activities).toMatchObject([{ kind: 'agent', status: 'succeeded' }]);
    expect(result.details.attempts).toMatchObject([{ executor: 'agent', ordinal: 1 }]);
  });

  it('hosts all three PL1 consensus participants through distinct private-port invocations', async () => {
    const { result, starts } = await runKnownAgentSnapshot(
      consensusPipeline,
      {},
      { vote: 'approve' },
    );

    expect(starts).toHaveLength(3);
    expect(new Set(starts.map(({ invocationId }) => invocationId)).size).toBe(3);
    expect(result.snapshot.status).toBe('succeeded');
    expect(result.details.activities).toHaveLength(3);
    expect(result.details.attempts.map(({ executor }) => executor)).toStrictEqual([
      'agent',
      'agent',
      'agent',
    ]);
  });

  it('delivers cancellation to the stable agent operation topic and reconciles the same identity', async () => {
    const { result, starts, cancellations } = await runKnownAgentSnapshot(
      singleAgentPipeline,
      { review: { strategy: 'single', participant: { key: 'reviewer', bindingKey: 'reviewer' } } },
      { decision: 'approved' },
      false,
      (input) => cancelledResult(input, input.binding.pin),
      true,
      async (runId) => {
        await DBOS.send(
          runWorkflowId(runId),
          { schemaVersion: 'run-cancellation-request/v1', actorId: 'operator-1' },
          'revo-run.coordinator',
          `cancel:${runId}`,
        );
      },
    );

    expect(starts).toHaveLength(1);
    expect(cancellations).toStrictEqual([starts[0]?.invocationId]);
    expect(result.snapshot).toMatchObject({
      status: 'cancelled',
      terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
    });
    expect(result.details.attempts).toMatchObject([{ status: 'cancelled' }]);
  });

  it('projects a known-v1 agent snapshot to recovery_required with the unavailable production port', async () => {
    const { result, starts } = await runKnownAgentSnapshot(
      singleAgentPipeline,
      { review: { strategy: 'single', participant: { key: 'reviewer', bindingKey: 'reviewer' } } },
      { decision: 'approved' },
      true,
    );

    expect(starts).toHaveLength(0);
    expect(result.snapshot).toMatchObject({ status: 'recovery_required', terminal: null });
    expect(result.details.recovery).toMatchObject([
      { executor: 'agent', reasonCode: 'outcome_unknown' },
    ]);
  });

  it('fails closed when a simulated agent result violates its durable private contract', async () => {
    const { result, starts } = await runKnownAgentSnapshot(
      singleAgentPipeline,
      { review: { strategy: 'single', participant: { key: 'reviewer', bindingKey: 'reviewer' } } },
      { decision: 'approved' },
      false,
      (input) => ({
        ...succeededResult(input, input.binding.pin, { decision: 'approved' }),
        outputDirectory: '/must-not-enter-durable-history',
      }),
    );

    expect(starts).toHaveLength(1);
    expect(result.snapshot).toMatchObject({ status: 'recovery_required', terminal: null });
    expect(result.details.recovery).toMatchObject([
      { executor: 'agent', reasonCode: 'outcome_unknown' },
    ]);
  });

  it('rejects every hostile agent terminal relay before receipt, journal, active command, or kernel mutation', async () => {
    type AgentRelayContext = Readonly<{
      readonly runId: string;
      readonly operation: string;
      readonly attemptId: string;
      readonly command: Extract<
        AdmittedRunSnapshotV1['initial']['commands'][number],
        { readonly kind: 'dispatchActivity' }
      >;
    }>;
    const terminalMismatchRelay = (
      context: AgentRelayContext,
      status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
    ) => ({
      schemaVersion: 'operation-observation-relay/v1' as const,
      observationReceiptId: operationReceiptId(context.runId, context.operation, 1),
      runId: context.runId,
      operationId: context.operation,
      commandKey: context.command.key,
      attemptOrdinal: 1,
      retrying: false,
      event:
        status === 'succeeded'
          ? {
              kind: 'activityFailed' as const,
              commandKey: context.command.key,
              ref: context.command.ref,
              errorCode: 'revo.agent.internal',
            }
          : {
              kind: 'activitySucceeded' as const,
              commandKey: context.command.key,
              ref: context.command.ref,
              output: { decision: 'approved' },
            },
      scriptResult: null,
      agentResult: hostileTerminalAgentResult(status, context.attemptId),
      preDispatchCancelled: false,
    });
    const timedOutFailureEvent = (context: AgentRelayContext) => ({
      kind: 'activityFailed' as const,
      commandKey: context.command.key,
      ref: context.command.ref,
      errorCode: 'revo.agent.timeout',
    });
    const cases = [
      {
        name: 'succeeded terminal result with a contradictory relay event',
        expectedError: 'Operation observation event does not match its owning terminal result.',
        status: 'succeeded' as const,
        relay: (context: AgentRelayContext) => terminalMismatchRelay(context, 'succeeded'),
      },
      {
        name: 'failed terminal result with a contradictory relay event',
        expectedError: 'Operation observation event does not match its owning terminal result.',
        status: 'failed' as const,
        relay: (context: AgentRelayContext) => terminalMismatchRelay(context, 'failed'),
      },
      {
        name: 'cancelled terminal result with a contradictory relay event',
        expectedError: 'Operation observation event does not match its owning terminal result.',
        status: 'cancelled' as const,
        relay: (context: AgentRelayContext) => terminalMismatchRelay(context, 'cancelled'),
      },
      {
        name: 'timed-out terminal result with a contradictory relay event',
        expectedError: 'Operation observation event does not match its owning terminal result.',
        status: 'timed_out' as const,
        relay: (context: AgentRelayContext) => terminalMismatchRelay(context, 'timed_out'),
      },
      {
        name: 'receipt that does not bind the active operation',
        expectedError: 'Operation observation relay has an invalid durable receipt.',
        status: 'timed_out' as const,
        relay: (context: AgentRelayContext) => ({
          schemaVersion: 'operation-observation-relay/v1' as const,
          observationReceiptId: 'opr_hostile_unbound',
          runId: context.runId,
          operationId: context.operation,
          commandKey: context.command.key,
          attemptOrdinal: 1,
          retrying: false,
          event: timedOutFailureEvent(context),
          scriptResult: null,
          agentResult: hostileTerminalAgentResult('timed_out', context.attemptId),
          preDispatchCancelled: false,
        }),
      },
      {
        name: 'zero attempt ordinal with an otherwise matching timed-out result',
        expectedError: 'Activity observation did not include its attempt ordinal.',
        status: 'timed_out' as const,
        relay: (context: AgentRelayContext) => ({
          schemaVersion: 'operation-observation-relay/v1' as const,
          observationReceiptId: operationReceiptId(context.runId, context.operation, 0),
          runId: context.runId,
          operationId: context.operation,
          commandKey: context.command.key,
          attemptOrdinal: 0,
          retrying: false,
          event: timedOutFailureEvent(context),
          scriptResult: null,
          agentResult: hostileTerminalAgentResult('timed_out', context.attemptId),
          preDispatchCancelled: false,
        }),
      },
    ] as const;

    for (const hostile of cases) {
      const runId = `rn1-private-agent-hostile-${randomUUID()}`;
      let before: KernelRunResult['details'] | null | undefined;
      let operationWorkflow: string | undefined;
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await expect(
        runKnownAgentSnapshot(
          singleAgentPipeline,
          {
            review: {
              strategy: 'single',
              participant: { key: 'reviewer', bindingKey: 'reviewer' },
            },
          },
          { decision: 'approved' },
          false,
          (input) => hostileTerminalAgentResult(hostile.status, input.invocationId),
          true,
          async (startedRunId) => {
            const rootWorkflowId = runWorkflowId(startedRunId);
            await expect
              .poll(
                async () =>
                  (
                    await DBOS.getEvent<KernelRunResult['details']>(
                      rootWorkflowId,
                      'revo-run.details',
                    )
                  )?.operations[0]?.status,
                { timeout: 10_000, interval: 20 },
              )
              .toBe('running');
            const [snapshot] =
              await DBOS.retrieveWorkflow<AdmittedRunSnapshotV1>(rootWorkflowId).getWorkflowInputs<
                [AdmittedRunSnapshotV1]
              >();
            const command = snapshot?.initial.commands.find(
              (
                candidate,
              ): candidate is Extract<
                (typeof snapshot.initial.commands)[number],
                { readonly kind: 'dispatchActivity' }
              > => candidate.kind === 'dispatchActivity',
            );
            if (command === undefined) {
              throw new Error('Expected the admitted agent activity command.');
            }
            const operation = operationId(startedRunId, command.key);
            operationWorkflow = operationWorkflowId(operation);
            before = await DBOS.getEvent<KernelRunResult['details']>(
              rootWorkflowId,
              'revo-run.details',
            );
            await DBOS.send(
              rootWorkflowId,
              hostile.relay({
                runId: startedRunId,
                operation,
                attemptId: attemptId(operation, 1),
                command,
              }),
              coordinatorTopic,
              operationReceiptId(startedRunId, operation, 1),
            );
          },
          runId,
        ),
      ).rejects.toThrow(hostile.expectedError);

      const rootWorkflowId = runWorkflowId(runId);
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      const after = await DBOS.getEvent<KernelRunResult['details']>(
        rootWorkflowId,
        'revo-run.details',
      );
      expect(before).toBeDefined();
      expect(after).toStrictEqual(before);
      expect(after).toMatchObject({
        status: 'running',
        terminal: null,
        operations: [{ kind: 'agent', status: 'running' }],
        attempts: [{ executor: 'agent', status: 'running' }],
      });
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await expect(DBOS.getWorkflowStatus(rootWorkflowId)).resolves.toMatchObject({
        status: 'ERROR',
      });
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await DBOS.deleteWorkflow(rootWorkflowId, true);
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await expect(DBOS.getWorkflowStatus(rootWorkflowId)).resolves.toBeNull();
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await expect(DBOS.getWorkflowStatus(operationWorkflow ?? '')).resolves.toBeNull();
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await DBOS.shutdown();
      if (composition !== undefined) {
        clearRunComposition(composition);
      }
      composition = undefined;
    }
  });
});
