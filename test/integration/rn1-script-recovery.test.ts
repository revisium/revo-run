import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PipelineSourcePackage } from '@revisium/revo-pipeline';
import type {
  AttemptCancellationResult,
  PreparedScriptBinding,
  RevoScripts,
  ScriptAttemptExecutionContext,
  ScriptAttemptInput,
  ScriptAttemptResult,
  ScriptReconciliationResult,
} from '@revisium/revo-scripts';
import { Type } from 'typebox';
import { Parse } from 'typebox/value';
import { afterEach, describe, expect, it } from 'vitest';

import { admitRun } from '../../src/admission/admit-run.js';
import { unavailableAgentPort } from '../../src/composition/agent-port.js';
import { RunHostReadinessFence } from '../../src/composition/readiness-fence.js';
import {
  clearRunComposition,
  installRunComposition,
  type RunComposition,
} from '../../src/composition/run-composition.js';
import type { AdmittedRunSnapshotV1 } from '../../src/contracts/admitted-run.js';
import type { CreateRunInput } from '../../src/contracts/manager.js';
import type { RunEvent } from '../../src/contracts/observation.js';
import { kernelRunWorkflow, type KernelRunResult } from '../../src/dbos/kernel-run-workflow.js';
import {
  coordinatorTopic,
  operationOutboxKey,
  type OperationOutboxRecordV1,
} from '../../src/dbos/operation-workflow.js';
import { operationWorkflowId, runWorkflowId } from '../../src/dbos/workflow-id.js';
import {
  attemptDispatchArbitrationWorkflowId,
  operationReceiptId,
} from '../../src/operations/identities.js';
import {
  assertRecoveryObservation,
  assertCancellationObservation,
  cancellationAttempt,
  cancellationExpectedBoolean,
  cancellationExpectedCount,
  cancellationExpectedRecord,
  cancellationExpectedString,
  cancellationMapping,
  cancellationMappings,
  recoveryExpectedString,
  recoveryScenario,
  type CanonicalCancellationMapping,
} from '../support/rn1-recovery-matrix.js';
import { testDatabaseUrl } from '../support/test-environment.js';
const recoveryGoldenSchema = Type.Object(
  {
    schemaVersion: Type.Literal('rn1-recovery-context/v1'),
    outcomes: Type.Object(
      {
        reconciliationUncertain: Type.Object(
          {
            status: Type.Literal('recovery_required'),
            reasonCode: Type.Literal('outcome_unknown'),
            terminalEventCount: Type.Literal(0),
          },
          { additionalProperties: false },
        ),
        reconciliationFailure: Type.Object(
          {
            status: Type.Literal('recovery_required'),
            reasonCode: Type.Literal('reconciliation_failed'),
            terminalEventCount: Type.Literal(0),
          },
          { additionalProperties: false },
        ),
        lateSealedTerminal: Type.Object(
          { status: Type.Literal('cancelled'), recoveryCount: Type.Literal(0) },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const rawRecoveryGolden: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/rn1/recovery-context.json', import.meta.url), 'utf8'),
);
const recoveryGolden = Parse(recoveryGoldenSchema, rawRecoveryGolden);

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const messageSchema = {
  type: 'object' as const,
  properties: { message: { type: 'string' as const, enum: ['recovery'] } },
  required: ['message'],
  additionalProperties: false as const,
};

const pipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-script-recovery',
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
        entry: 'script',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'script',
            id: 'script',
            requirementKey: 'recovery',
            script: { id: 'script:test/recovery', version: 1 },
            input: { message: { kind: 'literal', value: 'recovery' } },
            inputSchema: messageSchema,
            outputSchema: messageSchema,
            routes: { succeeded: 'done', failed: 'done', cancelled: 'done' },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const binding: PreparedScriptBinding = {
  schemaVersion: 'prepared-script-binding/v1',
  script: { id: 'script:test/recovery', version: 1 },
  definitionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000091',
  implementation: {
    id: '@revisium/revo-run/test/recovery',
    version: '1.0.0',
    buildDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000092',
  },
  providers: [],
  resources: {},
  credentials: {},
  attemptPolicy: {
    timeoutMs: 1,
    terminationGraceMs: 1_000,
    retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
    idempotency: 'read-only',
  },
};

const uncertain: ScriptAttemptResult = {
  kind: 'uncertain',
  trigger: 'timeout',
  stage: 'handler',
  evidence: [],
};

const succeeded: Extract<ScriptAttemptResult, { readonly kind: 'succeeded' }> = {
  kind: 'succeeded',
  value: { message: 'recovery' },
  evidence: [],
  terminalEvent: {
    emissionOrdinal: 2,
    event: {
      name: 'revo.script.succeeded',
      details: {
        script: binding.script,
        definitionDigest: binding.definitionDigest,
        attemptOrdinal: 1,
        timestampMs: 1,
        evidenceCount: 0,
      },
    },
  },
};

const cancelled: Extract<ScriptAttemptResult, { readonly kind: 'cancelled' }> = {
  kind: 'cancelled',
  evidence: [],
  terminalEvent: {
    emissionOrdinal: 2,
    event: {
      name: 'revo.script.cancelled',
      details: {
        script: binding.script,
        definitionDigest: binding.definitionDigest,
        attemptOrdinal: 1,
        timestampMs: 1,
      },
    },
  },
};

const createScripts = (
  reconcile: (input: ScriptAttemptInput) => ScriptReconciliationResult,
  attempts: ScriptAttemptInput[],
  execute: (
    input: ScriptAttemptInput,
    context: ScriptAttemptExecutionContext,
  ) => ScriptAttemptResult | Promise<ScriptAttemptResult> = () => uncertain,
  prepared: PreparedScriptBinding = binding,
  cancel: (
    input: Readonly<{ readonly executionId: string; readonly attemptId: string }>,
  ) => AttemptCancellationResult = () => ({ kind: 'acknowledged' }),
): RevoScripts => ({
  prepareBinding: async () => prepared,
  executeAttempt: async (input, context) => {
    attempts.push(input);
    return execute(input, context);
  },
  cancelAttempt: async (input) => cancel(input),
  reconcileAttempt: async (input) => reconcile(input),
  listManifests: () => [],
  listProviderImplementations: () => [],
});

let composition: RunComposition | undefined;

afterEach(async () => {
  await DBOS.shutdown();
  if (composition !== undefined) {
    clearRunComposition(composition);
  }
  composition = undefined;
});

const run = async (
  reconcile: (input: ScriptAttemptInput) => ScriptReconciliationResult,
  options: Readonly<{
    readonly execute?: (
      input: ScriptAttemptInput,
      context: ScriptAttemptExecutionContext,
    ) => ScriptAttemptResult | Promise<ScriptAttemptResult>;
    readonly binding?: PreparedScriptBinding;
  }> = {},
): Promise<{
  readonly result: KernelRunResult;
  readonly attempts: readonly ScriptAttemptInput[];
  readonly events: readonly RunEvent[];
}> => {
  const attempts: ScriptAttemptInput[] = [];
  const fence = new RunHostReadinessFence();
  fence.open();
  composition = {
    fence,
    agents: unavailableAgentPort,
    scripts: createScripts(reconcile, attempts, options.execute, options.binding),
  };
  installRunComposition(composition);
  DBOS.setConfig({ name: 'revo-run-script-recovery-test', systemDatabaseUrl: testDatabaseUrl() });
  await DBOS.launch();
  const runId = `rn1-script-recovery-${randomUUID()}`;
  const input: CreateRunInput = {
    runId,
    pipeline,
    profile: {
      schemaVersion: 'run-profile/v1',
      selections: {},
      bindings: { agents: {}, scripts: { recovery: { resources: {}, credentials: {} } } },
    },
    input: {},
  };
  const admitted = await admitRun(input, composition);
  await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: runWorkflowId(runId) })(admitted);
  const result = await DBOS.retrieveWorkflow<KernelRunResult>(runWorkflowId(runId)).getResult();
  const events: RunEvent[] = [];
  for await (const event of DBOS.readStream<RunEvent>(runWorkflowId(runId), 'revo-run.events')) {
    events.push(event);
  }
  return { result, attempts, events };
};

const startPendingScriptCancellation = async (
  cancellationResult: AttemptCancellationResult,
  reconciliation: (input: ScriptAttemptInput) => ScriptReconciliationResult,
  options: Readonly<{
    readonly binding?: PreparedScriptBinding;
    readonly beforePending?: ScriptAttemptResult;
    readonly pendingAttemptOrdinal?: number;
    readonly waitForPendingAttempt?: boolean;
    readonly expectScriptCancellation?: boolean;
  }> = {},
): Promise<{
  readonly attempts: readonly ScriptAttemptInput[];
  readonly cancellations: readonly { readonly executionId: string; readonly attemptId: string }[];
  readonly cancellationResults: readonly AttemptCancellationResult[];
  readonly reconciliations: readonly ScriptAttemptInput[];
  readonly resolveExecution: (result: ScriptAttemptResult) => void;
  readonly details: () => Promise<KernelRunResult['details'] | null>;
  readonly kernelCancellationEvent: () => Promise<Readonly<Record<string, unknown>> | null>;
  readonly result: () => Promise<KernelRunResult>;
}> => {
  const attempts: ScriptAttemptInput[] = [];
  const cancellations: { readonly executionId: string; readonly attemptId: string }[] = [];
  const cancellationResults: AttemptCancellationResult[] = [];
  const reconciliations: ScriptAttemptInput[] = [];
  let resolveExecution: ((result: ScriptAttemptResult) => void) | undefined;
  const fence = new RunHostReadinessFence();
  fence.open();
  composition = {
    fence,
    agents: unavailableAgentPort,
    scripts: createScripts(
      (input) => {
        reconciliations.push(input);
        return reconciliation(input);
      },
      attempts,
      (input) => {
        if (options.beforePending !== undefined && input.attemptOrdinal === 1) {
          return options.beforePending;
        }
        return new Promise<ScriptAttemptResult>((resolve) => {
          resolveExecution = resolve;
        });
      },
      options.binding ?? binding,
      (input) => {
        cancellations.push(input);
        cancellationResults.push(cancellationResult);
        return cancellationResult;
      },
    ),
  };
  installRunComposition(composition);
  DBOS.setConfig({
    name: 'revo-run-script-cancellation-test',
    systemDatabaseUrl: testDatabaseUrl(),
  });
  await DBOS.launch();
  const runId = `rn1-script-cancellation-${randomUUID()}`;
  const admitted = await admitRun(
    {
      runId,
      pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {},
        bindings: { agents: {}, scripts: { recovery: { resources: {}, credentials: {} } } },
      },
      input: {},
    },
    composition,
  );
  const rootWorkflowId = runWorkflowId(runId);
  await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: rootWorkflowId })(admitted);
  if (options.waitForPendingAttempt) {
    await expect
      .poll(
        async () =>
          (
            await DBOS.getEvent<KernelRunResult['details']>(rootWorkflowId, 'revo-run.details')
          )?.attempts.find(({ ordinal }) => ordinal === options.pendingAttemptOrdinal)?.status,
        { timeout: 10_000, interval: 20 },
      )
      .toBe('pending');
  } else {
    await expect
      .poll(() => attempts.length, { timeout: 10_000, interval: 20 })
      .toBe(options.pendingAttemptOrdinal ?? 1);
  }
  await DBOS.send(
    rootWorkflowId,
    { schemaVersion: 'run-cancellation-request/v1', actorId: 'operator-1' },
    'revo-run.coordinator',
    `cancel:${runId}`,
  );
  if (options.expectScriptCancellation ?? true) {
    await expect.poll(() => cancellations.length, { timeout: 10_000, interval: 20 }).toBe(1);
  }
  return {
    attempts,
    cancellations,
    cancellationResults,
    reconciliations,
    resolveExecution: (result) => {
      if (resolveExecution === undefined) {
        throw new Error('Expected the active script execution before cancellation.');
      }
      resolveExecution(result);
    },
    details: async () =>
      await DBOS.getEvent<KernelRunResult['details']>(rootWorkflowId, 'revo-run.details'),
    kernelCancellationEvent: async () => {
      const events: RunEvent[] = [];
      for await (const event of DBOS.readStream<RunEvent>(rootWorkflowId, 'revo-run.events')) {
        events.push(event);
      }
      if (
        !events.some(
          ({ payload }) =>
            payload.type === 'script.event' && payload.event.name === 'revo.script.cancelled',
        )
      ) {
        return null;
      }
      const details = await DBOS.getEvent<KernelRunResult['details']>(
        rootWorkflowId,
        'revo-run.details',
      );
      const operation = details?.operations.find(({ kind }) => kind === 'script');
      if (operation === undefined) {
        throw new Error('Cancelled script has no observed operation.');
      }
      const outbox = await DBOS.getEvent<OperationOutboxRecordV1>(
        rootWorkflowId,
        operationOutboxKey(operation.operationId),
      );
      if (outbox?.command.kind !== 'dispatchActivity') {
        throw new Error('Cancelled script has no dispatched kernel command.');
      }
      return {
        kind: 'activityCancelled',
        commandKey: outbox.command.key,
        ref: outbox.command.ref,
      };
    },
    result: async () => await DBOS.retrieveWorkflow<KernelRunResult>(rootWorkflowId).getResult(),
  };
};

const transientRetryBinding: PreparedScriptBinding = {
  ...binding,
  attemptPolicy: {
    ...binding.attemptPolicy,
    retry: { mode: 'transient', maxAttempts: 2, backoffMs: [0] },
  },
};

const retryableFailure = (
  ordinal: number,
): Extract<ScriptAttemptResult, { readonly kind: 'failed' }> => ({
  kind: 'failed',
  error: {
    code: 'revo.script.execution.handler_failed',
    message: 'retry me',
    retryable: true,
    stage: 'handler',
    details: null,
    causes: [],
  },
  evidence: [],
  terminalEvent: {
    emissionOrdinal: 2,
    event: {
      name: 'revo.script.failed',
      details: {
        script: binding.script,
        definitionDigest: binding.definitionDigest,
        attemptOrdinal: ordinal,
        timestampMs: 1,
        code: 'revo.script.execution.handler_failed',
        stage: 'handler',
        retryable: true,
      },
    },
  },
});

const timedOutFailure = (): Extract<ScriptAttemptResult, { readonly kind: 'timedOut' }> => ({
  kind: 'timedOut',
  error: {
    code: 'revo.script.timeout.wall_clock',
    message: 'timed out',
    retryable: false,
    stage: 'timeout',
    details: null,
    causes: [],
  },
  evidence: [],
  terminalEvent: {
    emissionOrdinal: 2,
    event: {
      name: 'revo.script.timed_out',
      details: {
        script: binding.script,
        definitionDigest: binding.definitionDigest,
        attemptOrdinal: 1,
        timestampMs: 1,
        code: 'revo.script.timeout.wall_clock',
      },
    },
  },
});

const cancelledFor = (
  ordinal: number,
): Extract<ScriptAttemptResult, { readonly kind: 'cancelled' }> => ({
  ...cancelled,
  terminalEvent: {
    ...cancelled.terminalEvent,
    event: {
      ...cancelled.terminalEvent.event,
      details: { ...cancelled.terminalEvent.event.details, attemptOrdinal: ordinal },
    },
  },
});

const cancellationResultFor = (
  mapping: CanonicalCancellationMapping,
  ordinal = 1,
): AttemptCancellationResult => {
  switch (mapping.variant) {
    case 'acknowledged':
      return { kind: 'acknowledged' };
    case 'alreadyTerminal':
      return { kind: 'alreadyTerminal', result: cancelledFor(ordinal) };
    case 'uncertain':
      return { kind: 'uncertain', result: uncertain };
    case 'notFound':
      return { kind: 'notFound' };
    case 'unknown':
      return { kind: 'unknown' };
  }
  throw new Error('Canonical cancellation mapping has an unreachable result variant.');
};

const cancellationResultObservation = (
  result: AttemptCancellationResult,
): Readonly<Record<string, unknown>> => {
  switch (result.kind) {
    case 'acknowledged':
    case 'notFound':
    case 'unknown':
      return { kind: result.kind };
    case 'alreadyTerminal':
      return { kind: result.kind, result: { kind: result.result.kind } };
    case 'uncertain':
      return {
        kind: result.kind,
        result: {
          kind: result.result.kind,
          trigger: result.result.trigger,
          stage: result.result.stage,
        },
      };
  }
  throw new Error('Script cancellation result has an unreachable variant.');
};

const activeCancellationResult = (
  active: Readonly<{ readonly cancellationResults: readonly AttemptCancellationResult[] }>,
): AttemptCancellationResult => {
  const result = active.cancellationResults[0];
  if (result === undefined) {
    throw new Error('Expected a public script cancellation response.');
  }
  return result;
};

const waitForRecoveryObservation = async (
  active: Readonly<{ readonly details: () => Promise<KernelRunResult['details'] | null> }>,
): Promise<void> => {
  await expect
    .poll(async () => (await active.details())?.recovery.length, {
      timeout: 10_000,
      interval: 20,
    })
    .toBeGreaterThan(0);
};

const reconciliationForCancellation = (
  mapping: CanonicalCancellationMapping,
  ordinal = 1,
): ((input: ScriptAttemptInput) => ScriptReconciliationResult) => {
  switch (mapping.action) {
    case 'reconcile_same_attempt':
      return () => ({ kind: 'terminal', result: cancelledFor(ordinal) });
    case 'seal_once':
      return () => {
        throw new Error('A sealed cancellation must not reconcile.');
      };
    case 'recovery_required_after_dispatch':
      return () => {
        throw new Error('A notFound cancellation must not reconcile before late settlement.');
      };
    case 'recovery_required':
      return () => ({ kind: 'uncertain', result: uncertain });
    default:
      throw new Error(`Canonical cancellation mapping has unsupported action ${mapping.action}.`);
  }
};

describe('RN1 private script recovery boundary', () => {
  it('recursively garbage-collects a root, its active operation, and its arbitration gate', async () => {
    const attempts: ScriptAttemptInput[] = [];
    const fence = new RunHostReadinessFence();
    fence.open();
    composition = {
      fence,
      agents: unavailableAgentPort,
      scripts: createScripts(
        () => ({ kind: 'unknown' }),
        attempts,
        async () => await new Promise<ScriptAttemptResult>(() => undefined),
      ),
    };
    installRunComposition(composition);
    DBOS.setConfig({
      name: 'revo-run-script-recursive-gc-test',
      systemDatabaseUrl: testDatabaseUrl(),
    });
    await DBOS.launch();

    const runId = `rn1-script-recursive-gc-${randomUUID()}`;
    const admitted = await admitRun(
      {
        runId,
        pipeline,
        profile: {
          schemaVersion: 'run-profile/v1',
          selections: {},
          bindings: { agents: {}, scripts: { recovery: { resources: {}, credentials: {} } } },
        },
        input: {},
      },
      composition,
    );
    const rootWorkflowId = runWorkflowId(runId);
    await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: rootWorkflowId })(admitted);
    await expect.poll(() => attempts.length, { timeout: 10_000, interval: 20 }).toBe(1);
    const currentAttempt = attempts[0];
    if (currentAttempt === undefined) {
      throw new Error('Expected the active script attempt.');
    }
    const childWorkflowId = operationWorkflowId(currentAttempt.executionId);
    const gateWorkflowId = attemptDispatchArbitrationWorkflowId(
      currentAttempt.executionId,
      currentAttempt.attemptId,
    );

    await expect(DBOS.getWorkflowStatus(rootWorkflowId)).resolves.not.toBeNull();
    await expect(DBOS.getWorkflowStatus(childWorkflowId)).resolves.not.toBeNull();
    await expect(DBOS.getWorkflowStatus(gateWorkflowId)).resolves.not.toBeNull();

    await DBOS.deleteWorkflow(rootWorkflowId, true);
    await expect(DBOS.getWorkflowStatus(rootWorkflowId)).resolves.toBeNull();
    await expect(DBOS.getWorkflowStatus(childWorkflowId)).resolves.toBeNull();
    await expect(DBOS.getWorkflowStatus(gateWorkflowId)).resolves.toBeNull();
  });

  it('rejects every hostile script terminal relay before receipt, journal, active command, or kernel mutation', async () => {
    const cases = [
      {
        kind: 'succeeded' as const,
        result: succeeded,
        event: (
          command: Extract<
            AdmittedRunSnapshotV1['initial']['commands'][number],
            { readonly kind: 'dispatchActivity' }
          >,
        ) => ({
          kind: 'activityFailed' as const,
          commandKey: command.key,
          ref: command.ref,
          errorCode: 'revo.script.execution.handler_failed',
        }),
      },
      {
        kind: 'failed' as const,
        result: retryableFailure(1),
        event: (
          command: Extract<
            AdmittedRunSnapshotV1['initial']['commands'][number],
            { readonly kind: 'dispatchActivity' }
          >,
        ) => ({
          kind: 'activitySucceeded' as const,
          commandKey: command.key,
          ref: command.ref,
          output: { message: 'recovery' },
        }),
      },
      {
        kind: 'cancelled' as const,
        result: cancelled,
        event: (
          command: Extract<
            AdmittedRunSnapshotV1['initial']['commands'][number],
            { readonly kind: 'dispatchActivity' }
          >,
        ) => ({
          kind: 'activitySucceeded' as const,
          commandKey: command.key,
          ref: command.ref,
          output: { message: 'recovery' },
        }),
      },
      {
        kind: 'timedOut' as const,
        result: timedOutFailure(),
        event: (
          command: Extract<
            AdmittedRunSnapshotV1['initial']['commands'][number],
            { readonly kind: 'dispatchActivity' }
          >,
        ) => ({
          kind: 'activitySucceeded' as const,
          commandKey: command.key,
          ref: command.ref,
          output: { message: 'recovery' },
        }),
      },
    ] as const;

    for (const hostile of cases) {
      const attempts: ScriptAttemptInput[] = [];
      const fence = new RunHostReadinessFence();
      fence.open();
      composition = {
        fence,
        agents: unavailableAgentPort,
        scripts: createScripts(
          () => ({ kind: 'unknown' }),
          attempts,
          async () => await new Promise<ScriptAttemptResult>(() => undefined),
        ),
      };
      installRunComposition(composition);
      DBOS.setConfig({
        name: `revo-run-script-hostile-${hostile.kind}`,
        systemDatabaseUrl: testDatabaseUrl(),
      });
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await DBOS.launch();
      const runId = `rn1-script-hostile-${hostile.kind}-${randomUUID()}`;
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      const admitted = await admitRun(
        {
          runId,
          pipeline,
          profile: {
            schemaVersion: 'run-profile/v1',
            selections: {},
            bindings: { agents: {}, scripts: { recovery: { resources: {}, credentials: {} } } },
          },
          input: {},
        },
        composition,
      );
      const rootWorkflowId = runWorkflowId(runId);
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: rootWorkflowId })(admitted);
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await expect.poll(() => attempts.length, { timeout: 10_000, interval: 20 }).toBe(1);
      const currentAttempt = attempts[0];
      if (currentAttempt === undefined) {
        throw new Error('Expected the active script attempt.');
      }
      const [snapshot] =
        // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
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
        throw new Error('Expected the admitted script activity command.');
      }
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      const before = await DBOS.getEvent<KernelRunResult['details']>(
        rootWorkflowId,
        'revo-run.details',
      );
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await DBOS.send(
        rootWorkflowId,
        {
          schemaVersion: 'operation-observation-relay/v1',
          observationReceiptId: operationReceiptId(runId, currentAttempt.executionId, 1),
          runId,
          operationId: currentAttempt.executionId,
          commandKey: command.key,
          attemptOrdinal: 1,
          retrying: false,
          event: hostile.event(command),
          scriptResult: hostile.result,
          agentResult: null,
          preDispatchCancelled: false,
        },
        coordinatorTopic,
        operationReceiptId(runId, currentAttempt.executionId, 1),
      );
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await expect(
        DBOS.retrieveWorkflow<KernelRunResult>(rootWorkflowId).getResult(),
      ).rejects.toThrow('Operation observation event does not match its owning terminal result.');
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      const after = await DBOS.getEvent<KernelRunResult['details']>(
        rootWorkflowId,
        'revo-run.details',
      );
      expect(after).toStrictEqual(before);
      expect(after).toMatchObject({
        status: 'running',
        terminal: null,
        operations: [{ kind: 'script', status: 'running' }],
        attempts: [{ executor: 'script', status: 'running' }],
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
      await expect(
        DBOS.getWorkflowStatus(operationWorkflowId(currentAttempt.executionId)),
      ).resolves.toBeNull();
      // oxlint-disable-next-line no-await-in-loop -- every case owns and tears down the DBOS singleton before the next one.
      await DBOS.shutdown();
      if (composition !== undefined) {
        clearRunComposition(composition);
      }
      composition = undefined;
    }
  });

  it('keeps an unresolved same-identity script attempt recovery-required without a terminal event', async () => {
    const scenario = recoveryScenario('D7');
    const reconciled: ScriptAttemptInput[] = [];
    const { attempts, events, result } = await run((input) => {
      reconciled.push(input);
      return { kind: 'uncertain', result: uncertain };
    });

    expect(result.snapshot.status).toBe(recoveryExpectedString(scenario, 'status'));
    expect(result.snapshot.terminal).toBeNull();
    expect(result.details.activities).toMatchObject([{ status: 'recovery_required' }]);
    expect(result.details.operations).toMatchObject([{ status: 'recovery_required' }]);
    expect(result.details.attempts).toMatchObject([{ status: 'unknown' }]);
    expect(result.details.recovery).toMatchObject([
      { reasonCode: recoveryGolden.outcomes.reconciliationUncertain.reasonCode },
    ]);
    expect(reconciled[0]).toMatchObject({
      executionId: attempts[0]?.executionId,
      attemptId: attempts[0]?.attemptId,
      attemptOrdinal: 1,
    });
    assertRecoveryObservation(scenario, {
      state: result.snapshot.terminal === null ? 'recovery_required' : 'terminal',
      status: result.snapshot.status,
      events: {
        script: events.filter(({ payload }) => payload.type === 'script.event').length,
        kernel: events.filter(({ payload }) => payload.type === 'run.terminal').length,
      },
      calls: { execute: attempts.length, reconcile: reconciled.length, cancel: 0 },
      prohibited: {
        newAttempt: attempts.length > 1,
        newRunEvent: events.some(({ payload }) => payload.type === 'run.terminal'),
      },
    });
  });

  it('accepts a late proven terminal reconciliation only with the same attempt identity', async () => {
    const scenario = recoveryScenario('D9');
    const reconciled: ScriptAttemptInput[] = [];
    const { attempts, events, result } = await run((input) => {
      reconciled.push(input);
      return { kind: 'terminal', result: succeeded };
    });

    expect(result.snapshot).toMatchObject({
      status: recoveryExpectedString(scenario, 'status'),
      terminal: { kind: 'succeeded', outcome: 'ok', output: {} },
    });
    expect(reconciled[0]).toMatchObject({
      executionId: attempts[0]?.executionId,
      attemptId: attempts[0]?.attemptId,
      attemptOrdinal: 1,
    });
    expect(result.details.attempts).toMatchObject([{ status: 'succeeded' }]);
    assertRecoveryObservation(scenario, {
      state: result.snapshot.terminal === null ? 'recovery_required' : 'terminal',
      status: result.snapshot.status,
      events: {
        script: events.filter(({ payload }) => payload.type === 'script.event').length,
        kernel: events.filter(({ payload }) => payload.type === 'run.terminal').length,
      },
      calls: { execute: attempts.length, reconcile: reconciled.length, cancel: 0 },
      prohibited: {
        newAttempt: attempts.length > 1,
        terminalBeforeProvenReconciliation: reconciled.length === 0,
      },
    });
  });

  it('classifies a reconciliation exception without synthesizing a script failure event', async () => {
    const { events, result } = await run(() => {
      throw new Error('provider reconciliation transport failed');
    });

    expect(result.snapshot).toMatchObject({
      status: recoveryGolden.outcomes.reconciliationFailure.status,
      terminal: null,
    });
    expect(result.details.recovery).toMatchObject([
      { reasonCode: recoveryGolden.outcomes.reconciliationFailure.reasonCode },
    ]);
    expect(events.filter(({ payload }) => payload.type === 'script.event')).toHaveLength(
      recoveryGolden.outcomes.reconciliationFailure.terminalEventCount,
    );
    expect(events.filter(({ payload }) => payload.type === 'run.terminal')).toHaveLength(
      recoveryGolden.outcomes.reconciliationFailure.terminalEventCount,
    );
  });

  it('rejects a malformed script result at the owning boundary without leaking host data', async () => {
    const secret = 'host-secret-must-not-be-public';
    const malformed: unknown = {
      kind: 'failed',
      error: {
        code: 'revo.script.execution.handler_failed',
        message: secret,
        retryable: false,
        stage: 'handler',
        details: { secret },
        causes: [],
        privateHostField: secret,
      },
      evidence: [],
      terminalEvent: cancelled.terminalEvent,
    };
    const { events, result } = await run(() => ({ kind: 'unknown' }), {
      execute: () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberate hostile host boundary input.
        return malformed as ScriptAttemptResult;
      },
    });

    expect(result.snapshot).toMatchObject({ status: 'recovery_required', terminal: null });
    expect(result.details.recovery).toMatchObject([{ reasonCode: 'outcome_unknown' }]);
    expect(events.filter(({ payload }) => payload.type === 'script.event')).toHaveLength(0);
    expect(JSON.stringify({ result, events })).not.toContain(secret);
  });

  it('maps cancellation notFound after dispatch_won to recovery-required without a terminal event', async () => {
    const mapping = cancellationMapping('notFound');
    const expectedReconciliations = cancellationExpectedCount(mapping, 'reconciliationCount');
    const expectedStatus = cancellationExpectedString(mapping, 'status');
    const expectedRecoveryCount = cancellationExpectedCount(mapping, 'recoveryCount');
    expect(mapping.expected.kernelEvent).toBeNull();
    expect(cancellationExpectedBoolean(mapping, 'terminal')).toBe(false);
    expect(cancellationExpectedBoolean(mapping, 'retryCreated')).toBe(false);
    expect(cancellationExpectedBoolean(mapping, 'newAttempt')).toBe(false);
    const attempts: ScriptAttemptInput[] = [];
    const cancellations: { readonly executionId: string; readonly attemptId: string }[] = [];
    const cancellationResults: AttemptCancellationResult[] = [];
    let reconciliationCount = 0;
    let resolveExecution: ((result: ScriptAttemptResult) => void) | undefined;
    const fence = new RunHostReadinessFence();
    fence.open();
    composition = {
      fence,
      agents: unavailableAgentPort,
      scripts: createScripts(
        () => {
          reconciliationCount += 1;
          throw new Error('A dispatched attempt must not reconcile for cancellation notFound.');
        },
        attempts,
        () =>
          new Promise<ScriptAttemptResult>((resolve) => {
            resolveExecution = resolve;
          }),
        binding,
        (input) => {
          cancellations.push(input);
          const result: AttemptCancellationResult = { kind: 'notFound' };
          cancellationResults.push(result);
          return result;
        },
      ),
    };
    installRunComposition(composition);
    DBOS.setConfig({ name: 'revo-run-script-cancel-test', systemDatabaseUrl: testDatabaseUrl() });
    await DBOS.launch();
    const runId = `rn1-script-cancel-${randomUUID()}`;
    const admitted = await admitRun(
      {
        runId,
        pipeline,
        profile: {
          schemaVersion: 'run-profile/v1',
          selections: {},
          bindings: { agents: {}, scripts: { recovery: { resources: {}, credentials: {} } } },
        },
        input: {},
      },
      composition,
    );
    const rootWorkflowId = runWorkflowId(runId);
    await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: rootWorkflowId })(admitted);
    await expect.poll(() => attempts.length, { timeout: 10_000, interval: 20 }).toBe(1);
    await DBOS.send(
      rootWorkflowId,
      { schemaVersion: 'run-cancellation-request/v1', actorId: 'operator-1' },
      'revo-run.coordinator',
      `cancel:${runId}`,
    );
    if (resolveExecution === undefined || attempts[0] === undefined) {
      throw new Error('Expected the active script attempt before cancellation.');
    }

    await expect.poll(() => cancellations.length, { timeout: 10_000, interval: 20 }).toBe(1);
    expect(cancellations).toStrictEqual([
      { executionId: attempts[0].executionId, attemptId: attempts[0].attemptId },
    ]);
    expect(reconciliationCount).toBe(expectedReconciliations);
    await expect
      .poll(
        async () =>
          (await DBOS.getEvent<KernelRunResult['details']>(rootWorkflowId, 'revo-run.details'))
            ?.status,
        { timeout: 10_000, interval: 20 },
      )
      .toBe(expectedStatus);
    const recoveringDetails = await DBOS.getEvent<KernelRunResult['details']>(
      rootWorkflowId,
      'revo-run.details',
    );
    expect(recoveringDetails).toMatchObject({
      status: expectedStatus,
      terminal: null,
      recovery: [{ reasonCode: 'outcome_unknown' }],
    });
    expect(recoveringDetails?.recovery).toHaveLength(expectedRecoveryCount);
    const cancellation = cancellationResults[0];
    if (cancellation === undefined) {
      throw new Error('Expected the public notFound cancellation response.');
    }
    assertCancellationObservation(mapping, {
      result: cancellationResultObservation(cancellation),
      expected: {
        kernelEvent: null,
        terminal: recoveringDetails?.terminal !== null,
        retryCreated: attempts.length > 1,
        newAttempt: attempts.length > 1,
        reconciliationCount,
        recoveryCount: recoveringDetails?.recovery.length ?? 0,
        status: recoveringDetails?.status,
        terminalEventCount: recoveringDetails?.terminal === null ? 0 : 1,
      },
    });

    resolveExecution(cancelled);
    const result = await DBOS.retrieveWorkflow<KernelRunResult>(rootWorkflowId).getResult();
    expect(result.snapshot).toMatchObject({
      status: 'cancelled',
      terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
    });
    expect(result.details.recovery).toHaveLength(0);
    await expect(
      DBOS.retrieveWorkflow(operationWorkflowId(attempts[0].executionId)).getResult(),
    ).resolves.toBeUndefined();
  });

  it('deduplicates a child uncertain recovery after cancellation already recorded the same attempt', async () => {
    const mapping = cancellationMapping('notFound');
    const active = await startPendingScriptCancellation(cancellationResultFor(mapping), () => {
      throw new Error('Cancellation notFound must not reconcile as pre-dispatch proof.');
    });
    await expect
      .poll(async () => (await active.details())?.status, { timeout: 10_000, interval: 20 })
      .toBe('recovery_required');

    active.resolveExecution(uncertain);
    const result = await active.result();

    expect(active.cancellations).toHaveLength(1);
    expect(active.reconciliations).toStrictEqual([
      {
        executionId: active.attempts[0]?.executionId,
        attemptId: active.attempts[0]?.attemptId,
        attemptOrdinal: 1,
        script: binding.script,
        binding,
        input: { message: 'recovery' },
      },
    ]);
    expect(result.snapshot).toMatchObject({ status: 'recovery_required', terminal: null });
    expect(result.details.recovery).toHaveLength(1);
    expect(result.details.recovery).toMatchObject([{ reasonCode: 'reconciliation_failed' }]);
  });

  it('reconciles an acknowledged cancellation using the active identity before settling', async () => {
    const mapping = cancellationMapping('acknowledged');
    const expectedReconciliations = cancellationExpectedCount(mapping, 'reconciliationCount');
    const expectedStatus = cancellationExpectedString(mapping, 'terminalStatus');
    const expectedRecoveryCount = cancellationExpectedCount(mapping, 'preTerminalRecoveryCount');
    expect(mapping.expected.kernelEvent).toBeNull();
    expect(cancellationExpectedBoolean(mapping, 'terminal')).toBe(false);
    expect(cancellationExpectedBoolean(mapping, 'retryCreated')).toBe(false);
    expect(cancellationExpectedBoolean(mapping, 'newAttempt')).toBe(false);
    const active = await startPendingScriptCancellation(
      cancellationResultFor(mapping),
      reconciliationForCancellation(mapping),
    );
    await expect
      .poll(() => active.reconciliations.length, { timeout: 10_000, interval: 20 })
      .toBe(expectedReconciliations);
    active.resolveExecution(cancelled);
    const result = await active.result();

    expect(active.attempts).toHaveLength(1);
    expect(active.cancellations).toStrictEqual([
      {
        executionId: active.attempts[0]?.executionId,
        attemptId: active.attempts[0]?.attemptId,
      },
    ]);
    expect(active.reconciliations).toMatchObject([
      {
        executionId: active.attempts[0]?.executionId,
        attemptId: active.attempts[0]?.attemptId,
        attemptOrdinal: 1,
      },
    ]);
    expect(result.snapshot).toMatchObject({
      status: expectedStatus,
      terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
    });
    expect(result.details.recovery).toHaveLength(expectedRecoveryCount);
    const cancellation = activeCancellationResult(active);
    assertCancellationObservation(mapping, {
      result: cancellationResultObservation(cancellation),
      expected: {
        kernelEvent: null,
        terminal: result.snapshot.terminal !== null && cancellation.kind !== 'acknowledged',
        retryCreated: active.attempts.length > 1,
        newAttempt: active.attempts.length > 1,
        reconciliationCount: active.reconciliations.length,
        preTerminalRecoveryCount: result.details.recovery.length,
        terminalStatus: result.snapshot.status,
      },
    });
  });

  it('accepts an already-terminal cancellation without a replacement execution or reconciliation', async () => {
    const mapping = cancellationMapping('alreadyTerminal');
    const expectedReconciliations = cancellationExpectedCount(mapping, 'reconciliationCount');
    const expectedStatus = cancellationExpectedString(mapping, 'terminalStatus');
    const expectedRecoveryCount = cancellationExpectedCount(mapping, 'preTerminalRecoveryCount');
    expect(cancellationExpectedRecord(mapping, 'kernelEvent').kind).toBe('activityCancelled');
    expect(cancellationExpectedBoolean(mapping, 'terminal')).toBe(true);
    expect(cancellationExpectedBoolean(mapping, 'retryCreated')).toBe(false);
    expect(cancellationExpectedBoolean(mapping, 'newAttempt')).toBe(false);
    const active = await startPendingScriptCancellation(
      cancellationResultFor(mapping),
      reconciliationForCancellation(mapping),
    );
    active.resolveExecution(cancelled);
    const result = await active.result();

    expect(active.attempts).toHaveLength(1);
    expect(active.reconciliations).toHaveLength(expectedReconciliations);
    expect(result.snapshot).toMatchObject({
      status: expectedStatus,
      terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
    });
    expect(result.details.recovery).toHaveLength(expectedRecoveryCount);
    const cancellation = activeCancellationResult(active);
    assertCancellationObservation(mapping, {
      result: cancellationResultObservation(cancellation),
      expected: {
        kernelEvent: await active.kernelCancellationEvent(),
        terminal: result.snapshot.terminal !== null,
        retryCreated: active.attempts.length > 1,
        newAttempt: active.attempts.length > 1,
        reconciliationCount: active.reconciliations.length,
        preTerminalRecoveryCount: result.details.recovery.length,
        terminalStatus: result.snapshot.status,
      },
    });
  });

  it('records uncertain or unknown cancellation before a late sealed terminal result settles it', async () => {
    const uncertainMapping = cancellationMapping('uncertain');
    const uncertainExpectedReconciliations = cancellationExpectedCount(
      uncertainMapping,
      'reconciliationCount',
    );
    const uncertainExpectedStatus = cancellationExpectedString(uncertainMapping, 'terminalStatus');
    expect(uncertainMapping.expected.kernelEvent).toBeNull();
    expect(cancellationExpectedBoolean(uncertainMapping, 'terminal')).toBe(false);
    expect(cancellationExpectedBoolean(uncertainMapping, 'retryCreated')).toBe(false);
    expect(cancellationExpectedBoolean(uncertainMapping, 'newAttempt')).toBe(false);
    const uncertainCancellation = await startPendingScriptCancellation(
      cancellationResultFor(uncertainMapping),
      reconciliationForCancellation(uncertainMapping),
    );
    await expect
      .poll(() => uncertainCancellation.reconciliations.length, {
        timeout: 10_000,
        interval: 20,
      })
      .toBe(uncertainExpectedReconciliations);
    await expect
      .poll(async () => (await uncertainCancellation.details())?.recovery.length, {
        timeout: 10_000,
        interval: 20,
      })
      .toBeGreaterThan(0);
    const uncertainPreSettlementDetails = await uncertainCancellation.details();
    uncertainCancellation.resolveExecution(cancelled);
    const uncertainResult = await uncertainCancellation.result();
    expect(uncertainResult.snapshot.status).toBe(recoveryGolden.outcomes.lateSealedTerminal.status);
    expect(uncertainResult.snapshot).toMatchObject({
      status: uncertainExpectedStatus,
      terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
    });
    expect(uncertainResult.details.recovery).toHaveLength(
      recoveryGolden.outcomes.lateSealedTerminal.recoveryCount,
    );
    const uncertainCancellationResult = activeCancellationResult(uncertainCancellation);
    assertCancellationObservation(uncertainMapping, {
      result: cancellationResultObservation(uncertainCancellationResult),
      expected: {
        kernelEvent: null,
        terminal: uncertainCancellationResult.kind === 'alreadyTerminal',
        retryCreated: uncertainCancellation.attempts.length > 1,
        newAttempt: uncertainCancellation.attempts.length > 1,
        reconciliationCount: uncertainCancellation.reconciliations.length,
        preTerminalRecoveryCount: uncertainPreSettlementDetails?.recovery.length ?? 0,
        terminalStatus: uncertainResult.snapshot.status,
      },
    });

    await DBOS.shutdown();
    if (composition !== undefined) {
      clearRunComposition(composition);
    }
    composition = undefined;

    const unknownMapping = cancellationMapping('unknown');
    const unknownExpectedReconciliations = cancellationExpectedCount(
      unknownMapping,
      'reconciliationCount',
    );
    const unknownExpectedStatus = cancellationExpectedString(unknownMapping, 'terminalStatus');
    expect(unknownMapping.expected.kernelEvent).toBeNull();
    expect(cancellationExpectedBoolean(unknownMapping, 'terminal')).toBe(false);
    expect(cancellationExpectedBoolean(unknownMapping, 'retryCreated')).toBe(false);
    expect(cancellationExpectedBoolean(unknownMapping, 'newAttempt')).toBe(false);
    const unknownCancellation = await startPendingScriptCancellation(
      cancellationResultFor(unknownMapping),
      reconciliationForCancellation(unknownMapping),
    );
    await expect
      .poll(async () => (await unknownCancellation.details())?.recovery.length, {
        timeout: 10_000,
        interval: 20,
      })
      .toBeGreaterThan(0);
    const unknownPreSettlementDetails = await unknownCancellation.details();
    unknownCancellation.resolveExecution(cancelled);
    const unknownResult = await unknownCancellation.result();
    expect(unknownCancellation.reconciliations).toHaveLength(unknownExpectedReconciliations);
    expect(unknownResult.snapshot).toMatchObject({
      status: unknownExpectedStatus,
      terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
    });
    expect(unknownResult.snapshot.status).toBe(recoveryGolden.outcomes.lateSealedTerminal.status);
    expect(unknownResult.details.recovery).toHaveLength(
      recoveryGolden.outcomes.lateSealedTerminal.recoveryCount,
    );
    const unknownCancellationResult = activeCancellationResult(unknownCancellation);
    assertCancellationObservation(unknownMapping, {
      result: cancellationResultObservation(unknownCancellationResult),
      expected: {
        kernelEvent: null,
        terminal: unknownCancellationResult.kind === 'alreadyTerminal',
        retryCreated: unknownCancellation.attempts.length > 1,
        newAttempt: unknownCancellation.attempts.length > 1,
        reconciliationCount: unknownCancellation.reconciliations.length,
        preTerminalRecoveryCount: unknownPreSettlementDetails?.recovery.length ?? 0,
        terminalStatus: unknownResult.snapshot.status,
      },
    });
  });

  it.each(cancellationMappings)(
    'uses the durable second retry attempt for $variant cancellation',
    async (mapping) => {
      const expectedReconciliations = cancellationExpectedCount(mapping, 'reconciliationCount');
      expect(cancellationExpectedBoolean(mapping, 'retryCreated')).toBe(false);
      expect(cancellationExpectedBoolean(mapping, 'newAttempt')).toBe(false);
      const active = await startPendingScriptCancellation(
        cancellationResultFor(mapping, 2),
        reconciliationForCancellation(mapping, 2),
        {
          binding: transientRetryBinding,
          beforePending: retryableFailure(1),
          pendingAttemptOrdinal: 2,
        },
      );

      await expect
        .poll(() => active.reconciliations.length, { timeout: 10_000, interval: 20 })
        .toBe(expectedReconciliations);
      if (
        mapping.variant === 'notFound' ||
        mapping.variant === 'uncertain' ||
        mapping.variant === 'unknown'
      ) {
        await waitForRecoveryObservation(active);
      }
      const preSettlementDetails = await active.details();
      active.resolveExecution(cancelledFor(2));
      const result = await active.result();
      const cancellation = activeCancellationResult(active);

      expect(active.attempts.map(({ attemptOrdinal }) => attemptOrdinal)).toStrictEqual([1, 2]);
      expect(cancellationAttempt.executionId).toMatch(/^op_/);
      expect(cancellationAttempt.attemptId).toMatch(/^att_/);
      expect(cancellationAttempt.attemptOrdinal).toBe(1);
      expect(active.attempts[0]?.input).toStrictEqual(cancellationAttempt.input);
      expect(active.attempts[1]?.executionId).toBe(active.attempts[0]?.executionId);
      expect(active.attempts[1]?.attemptId).not.toBe(active.attempts[0]?.attemptId);
      expect(active.cancellations).toStrictEqual([
        {
          executionId: active.attempts[1]?.executionId,
          attemptId: active.attempts[1]?.attemptId,
        },
      ]);
      expect(active.reconciliations).toMatchObject(
        expectedReconciliations === 0
          ? []
          : [
              {
                executionId: active.attempts[1]?.executionId,
                attemptId: active.attempts[1]?.attemptId,
                attemptOrdinal: 2,
              },
            ],
      );
      expect(result.snapshot).toMatchObject({
        status: 'cancelled',
        terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
      });
      expect(result.details.attempts).toMatchObject([
        { ordinal: 1, status: 'failed' },
        { ordinal: 2, status: 'cancelled' },
      ]);
      assertCancellationObservation(mapping, {
        result: cancellationResultObservation(cancellation),
        expected: {
          kernelEvent:
            cancellation.kind === 'alreadyTerminal' ? await active.kernelCancellationEvent() : null,
          terminal: cancellation.kind === 'alreadyTerminal',
          retryCreated: active.attempts.length > 2,
          newAttempt: active.attempts.length > 2,
          reconciliationCount: active.reconciliations.length,
          ...(mapping.variant === 'notFound'
            ? {
                recoveryCount: preSettlementDetails?.recovery.length ?? 0,
                status: preSettlementDetails?.status,
                terminalEventCount: preSettlementDetails?.terminal === null ? 0 : 1,
              }
            : {
                preTerminalRecoveryCount: preSettlementDetails?.recovery.length ?? 0,
                terminalStatus: result.snapshot.status,
              }),
        },
      });
    },
  );

  it('cancels a recorded pending retry before its second physical dispatch', async () => {
    const delayedRetryBinding: PreparedScriptBinding = {
      ...transientRetryBinding,
      attemptPolicy: {
        ...transientRetryBinding.attemptPolicy,
        retry: { mode: 'transient', maxAttempts: 2, backoffMs: [5_000] },
      },
    };
    const active = await startPendingScriptCancellation(
      cancellationResultFor(cancellationMapping('acknowledged')),
      () => {
        throw new Error(
          'A retry pending before dispatch has no provider cancellation to reconcile.',
        );
      },
      {
        binding: delayedRetryBinding,
        beforePending: retryableFailure(1),
        pendingAttemptOrdinal: 2,
        waitForPendingAttempt: true,
        expectScriptCancellation: false,
      },
    );

    const result = await active.result();

    expect(active.attempts.map(({ attemptOrdinal }) => attemptOrdinal)).toStrictEqual([1]);
    expect(active.cancellations).toStrictEqual([]);
    expect(result.snapshot).toMatchObject({
      status: 'cancelled',
      terminal: { kind: 'cancelled', reasonCode: 'run.cancel_requested' },
    });
    expect(result.details.activities).toMatchObject([{ status: 'cancelled', failure: null }]);
    expect(result.details.operations).toMatchObject([{ status: 'cancelled' }]);
    expect(result.details.attempts).toMatchObject([
      { ordinal: 1, status: 'failed' },
      { ordinal: 2, status: 'cancelled' },
    ]);
  });

  it('retries only a retryable terminal failure under the prepared transient policy', async () => {
    const retryBinding: PreparedScriptBinding = {
      ...binding,
      attemptPolicy: {
        ...binding.attemptPolicy,
        retry: { mode: 'transient', maxAttempts: 2, backoffMs: [0] },
      },
    };
    const failed = (
      ordinal: number,
    ): Extract<ScriptAttemptResult, { readonly kind: 'failed' }> => ({
      kind: 'failed',
      error: {
        code: 'revo.script.execution.handler_failed',
        message: 'retry me',
        retryable: true,
        stage: 'handler',
        details: null,
        causes: [],
      },
      evidence: [],
      terminalEvent: {
        emissionOrdinal: 2,
        event: {
          name: 'revo.script.failed',
          details: {
            script: binding.script,
            definitionDigest: binding.definitionDigest,
            attemptOrdinal: ordinal,
            timestampMs: 1,
            code: 'revo.script.execution.handler_failed',
            stage: 'handler',
            retryable: true,
          },
        },
      },
    });
    const succeeding = (
      ordinal: number,
    ): Extract<ScriptAttemptResult, { readonly kind: 'succeeded' }> => ({
      ...succeeded,
      terminalEvent: {
        ...succeeded.terminalEvent,
        event: {
          ...succeeded.terminalEvent.event,
          details: { ...succeeded.terminalEvent.event.details, attemptOrdinal: ordinal },
        },
      },
    });
    const { attempts, result } = await run(
      () => {
        throw new Error('terminal failure must not reconcile');
      },
      {
        binding: retryBinding,
        execute: (input) => (input.attemptOrdinal === 1 ? failed(1) : succeeding(2)),
      },
    );

    expect(attempts.map(({ attemptOrdinal }) => attemptOrdinal)).toStrictEqual([1, 2]);
    expect(attempts[1]?.executionId).toBe(attempts[0]?.executionId);
    expect(attempts[1]?.attemptId).not.toBe(attempts[0]?.attemptId);
    expect(result.snapshot.status).toBe('succeeded');
    expect(result.details.attempts).toMatchObject([
      { ordinal: 1, status: 'failed' },
      { ordinal: 2, status: 'succeeded' },
    ]);
  });

  it('accepts a live event from the durable second retry attempt', async () => {
    const retryBinding: PreparedScriptBinding = {
      ...binding,
      attemptPolicy: {
        ...binding.attemptPolicy,
        retry: { mode: 'transient', maxAttempts: 2, backoffMs: [0] },
      },
    };
    const failed: Extract<ScriptAttemptResult, { readonly kind: 'failed' }> = {
      kind: 'failed',
      error: {
        code: 'revo.script.execution.handler_failed',
        message: 'retry me',
        retryable: true,
        stage: 'handler',
        details: null,
        causes: [],
      },
      evidence: [],
      terminalEvent: {
        emissionOrdinal: 2,
        event: {
          name: 'revo.script.failed',
          details: {
            script: binding.script,
            definitionDigest: binding.definitionDigest,
            attemptOrdinal: 1,
            timestampMs: 1,
            code: 'revo.script.execution.handler_failed',
            stage: 'handler',
            retryable: true,
          },
        },
      },
    };
    const { events, result } = await run(
      () => {
        throw new Error('terminal retry does not reconcile');
      },
      {
        binding: retryBinding,
        execute: async (input, context) => {
          if (input.attemptOrdinal === 1) {
            return failed;
          }
          await context.events.emit({
            emissionOrdinal: 1,
            event: {
              name: 'revo.script.started',
              details: {
                script: binding.script,
                definitionDigest: binding.definitionDigest,
                attemptOrdinal: 2,
                timestampMs: 2,
              },
            },
          });
          return {
            ...succeeded,
            terminalEvent: {
              ...succeeded.terminalEvent,
              event: {
                ...succeeded.terminalEvent.event,
                details: {
                  ...succeeded.terminalEvent.event.details,
                  attemptOrdinal: 2,
                },
              },
            },
          };
        },
      },
    );

    expect(result.snapshot.status).toBe('succeeded');
    expect(
      events.some(
        (event) =>
          event.payload.type === 'script.event' &&
          event.payload.emissionOrdinal === 1 &&
          event.payload.event.name === 'revo.script.started',
      ),
    ).toBe(true);
  });
});
