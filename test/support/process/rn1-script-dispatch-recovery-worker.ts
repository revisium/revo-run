import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PipelineSourcePackage } from '@revisium/revo-pipeline';
import type {
  PreparedScriptBinding,
  RevoScripts,
  ScriptAttemptResult,
  ScriptReconciliationResult,
} from '@revisium/revo-scripts';

import { admitRun } from '../../../src/admission/admit-run.js';
import { unavailableAgentPort } from '../../../src/composition/agent-port.js';
import { RunHostReadinessFence } from '../../../src/composition/readiness-fence.js';
import {
  clearRunComposition,
  installRunComposition,
  type RunComposition,
} from '../../../src/composition/run-composition.js';
import type { CreateRunInput } from '../../../src/contracts/manager.js';
import { kernelRunWorkflow, type KernelRunResult } from '../../../src/dbos/kernel-run-workflow.js';
import { runWorkflowId } from '../../../src/dbos/workflow-id.js';

type KernelTestFaultPoint =
  | 'after-arbitration-start-before-result'
  | 'after-script-dispatch-intent'
  | 'before-script-dispatch-intent-commit'
  | 'before-script-provider-decision'
  | 'before-pre-dispatch-cancellation-relay'
  | 'after-script-acceptance'
  | 'after-script-provider-step'
  | 'after-script-reconciliation'
  | 'after-script-terminal-persisted'
  | 'after-kernel-advance'
  | 'before-coordinator-receive';

const databaseUrl = process.env.RN1_TEST_DATABASE_URL;
const runId = process.env.RN1_TEST_RUN_ID;
const mode = process.env.RN1_TEST_MODE;
const faultPoints = new Set(
  (process.env.RN1_TEST_FAULT_POINTS ?? '')
    .split(',')
    .filter((point): point is KernelTestFaultPoint => point.length > 0),
);
const pipelineMode = process.env.RN1_TEST_PIPELINE;
const reconciliationMode = process.env.RN1_TEST_RECONCILE;
const cancellationMode = process.env.RN1_TEST_CANCEL;

if (
  databaseUrl === undefined ||
  runId === undefined ||
  (mode !== 'start' && mode !== 'recover' && mode !== 'recover-closed')
) {
  throw new Error('RN1 script dispatch recovery worker has invalid input.');
}

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
  key: 'rn1-script-dispatch-recovery',
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

const twoScriptPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-two-script-dispatch-recovery',
  entryModule: 'main',
  maximumTotalActivities: 2,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'first',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'script',
            id: 'first',
            requirementKey: 'recovery',
            script: { id: 'script:test/recovery', version: 1 },
            input: { message: { kind: 'literal', value: 'recovery' } },
            inputSchema: messageSchema,
            outputSchema: messageSchema,
            routes: { succeeded: 'second', failed: 'second', cancelled: 'second' },
          },
          {
            kind: 'script',
            id: 'second',
            requirementKey: 'recovery-second',
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

const parallelScriptPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-parallel-script-recovery',
  entryModule: 'main',
  maximumTotalActivities: 2,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'parallel',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'parallel',
            id: 'parallel',
            policy: { kind: 'all' },
            remaining: 'drain',
            routes: {
              completed: 'done',
              impossible: 'done',
              failed: 'done',
              cancelled: 'done',
            },
            branches: [
              {
                key: 'unknown',
                input: {},
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
                region: {
                  key: 'unknown-region',
                  inputSchema: emptySchema,
                  entry: 'unknown-script',
                  outputSchema: emptySchema,
                  exits: [{ outcome: 'ok', outputSchema: emptySchema }],
                  nodes: [
                    {
                      kind: 'script',
                      id: 'unknown-script',
                      requirementKey: 'unknown',
                      script: { id: 'script:test/recovery-unknown', version: 1 },
                      input: { message: { kind: 'literal', value: 'recovery' } },
                      inputSchema: messageSchema,
                      outputSchema: messageSchema,
                      routes: {
                        succeeded: 'unknown-end',
                        failed: 'unknown-end',
                        cancelled: 'unknown-end',
                      },
                    },
                    { kind: 'end', id: 'unknown-end', outcome: 'ok', output: {} },
                  ],
                },
              },
              {
                key: 'terminal',
                input: {},
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
                region: {
                  key: 'terminal-region',
                  inputSchema: emptySchema,
                  entry: 'terminal-script',
                  outputSchema: emptySchema,
                  exits: [{ outcome: 'ok', outputSchema: emptySchema }],
                  nodes: [
                    {
                      kind: 'script',
                      id: 'terminal-script',
                      requirementKey: 'terminal',
                      script: { id: 'script:test/recovery-terminal', version: 1 },
                      input: { message: { kind: 'literal', value: 'recovery' } },
                      inputSchema: messageSchema,
                      outputSchema: messageSchema,
                      routes: {
                        succeeded: 'terminal-end',
                        failed: 'terminal-end',
                        cancelled: 'terminal-end',
                      },
                    },
                    { kind: 'end', id: 'terminal-end', outcome: 'ok', output: {} },
                  ],
                },
              },
            ],
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

const terminal = (): Extract<ScriptAttemptResult, { readonly kind: 'succeeded' }> => ({
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
});

const terminalFor = (
  script: Readonly<{ readonly id: `script:${string}`; readonly version: number }>,
): Extract<ScriptAttemptResult, { readonly kind: 'succeeded' }> => ({
  ...terminal(),
  terminalEvent: {
    emissionOrdinal: 2,
    event: {
      name: 'revo.script.succeeded',
      details: {
        ...terminal().terminalEvent.event.details,
        script,
      },
    },
  },
});

const send = (kind: string, extra: Readonly<Record<string, unknown>> = {}): void => {
  process.send?.({ kind, ...extra });
};

const scripts: RevoScripts = {
  prepareBinding: async () => binding,
  executeAttempt: async (input, context) => {
    send('execute', { executionId: input.executionId, attemptId: input.attemptId });
    await freezeAtFault('after-script-acceptance');
    await context.events.emit({
      emissionOrdinal: 1,
      event: {
        name: 'revo.script.started',
        details: {
          script: binding.script,
          definitionDigest: binding.definitionDigest,
          attemptOrdinal: 1,
          timestampMs: 1,
        },
      },
    });
    return pipelineMode === 'parallel' && input.script.id.endsWith('recovery-unknown')
      ? { kind: 'uncertain', trigger: 'timeout', stage: 'handler', evidence: [] }
      : terminalFor(input.script);
  },
  cancelAttempt: async (input) => {
    send('cancel', { executionId: input.executionId, attemptId: input.attemptId });
    return cancellationMode === 'notFound' ? { kind: 'notFound' } : { kind: 'acknowledged' };
  },
  reconcileAttempt: async (input): Promise<ScriptReconciliationResult> => {
    send('reconcile', { executionId: input.executionId, attemptId: input.attemptId });
    await freezeAtFault('after-script-reconciliation');
    if (pipelineMode === 'parallel' && input.script.id.endsWith('recovery-unknown')) {
      return { kind: 'unknown' };
    }
    if (reconciliationMode === 'notFound') {
      return { kind: 'notFound' };
    }
    return { kind: 'terminal', result: terminalFor(input.script) };
  },
  listManifests: () => [],
  listProviderImplementations: () => [],
};

const input: CreateRunInput = {
  runId,
  pipeline:
    pipelineMode === 'two'
      ? twoScriptPipeline
      : pipelineMode === 'parallel'
        ? parallelScriptPipeline
        : pipeline,
  profile: {
    schemaVersion: 'run-profile/v1',
    selections: {},
    bindings: {
      agents: {},
      scripts:
        pipelineMode === 'two'
          ? {
              recovery: { resources: {}, credentials: {} },
              'recovery-second': { resources: {}, credentials: {} },
            }
          : pipelineMode === 'parallel'
            ? {
                unknown: { resources: {}, credentials: {} },
                terminal: { resources: {}, credentials: {} },
              }
            : { recovery: { resources: {}, credentials: {} } },
    },
  },
  input: {},
};

const freezeAtFault = async (
  point: KernelTestFaultPoint,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  if (!faultPoints.has(point)) {
    return;
  }
  send('fault', { point, ...extra });
  await new Promise<void>(() => undefined);
};

type TestPatchedDbos = {
  send: (...args: readonly unknown[]) => Promise<unknown>;
  startWorkflow: (...args: readonly unknown[]) => unknown;
  runStep: (...args: readonly unknown[]) => Promise<unknown>;
  recv: (...args: readonly unknown[]) => Promise<unknown>;
  setEvent: (...args: readonly unknown[]) => Promise<unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOption = (value: unknown, name: string): string | undefined =>
  isRecord(value) && typeof value[name] === 'string' ? value[name] : undefined;

type AsyncUnknownFunction = (...args: readonly unknown[]) => Promise<unknown>;

const isAsyncUnknownFunction = (value: unknown): value is AsyncUnknownFunction =>
  typeof value === 'function';

/** Process-only DBOS boundary pauses; package source has no test hooks. */
const installProcessPauseBoundaries = (): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only replacement of process-local DBOS boundary methods.
  const mutable = DBOS as unknown as TestPatchedDbos;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/unbound-method -- test wrapper invokes DBOS static method with its original receiver-independent signature.
  const originalSend = DBOS.send as unknown as TestPatchedDbos['send'];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/unbound-method -- test wrapper invokes DBOS static method with its original receiver-independent signature.
  const originalStartWorkflow = DBOS.startWorkflow as unknown as TestPatchedDbos['startWorkflow'];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/unbound-method -- test wrapper invokes DBOS static method with its original receiver-independent signature.
  const originalRunStep = DBOS.runStep as unknown as TestPatchedDbos['runStep'];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/unbound-method -- test wrapper invokes DBOS static method with its original receiver-independent signature.
  const originalReceive = DBOS.recv as unknown as TestPatchedDbos['recv'];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/unbound-method -- test wrapper invokes DBOS static method with its original receiver-independent signature.
  const originalSetEvent = DBOS.setEvent as unknown as TestPatchedDbos['setEvent'];

  mutable.startWorkflow = (...args): unknown => {
    const invocation = originalStartWorkflow(...args);
    const workflowId = stringOption(args[1], 'workflowID');
    if (workflowId?.startsWith('arg_') !== true || !isAsyncUnknownFunction(invocation)) {
      return invocation;
    }
    return async (...workflowInput: readonly unknown[]): Promise<unknown> => {
      const handle = await invocation(...workflowInput);
      await freezeAtFault('after-arbitration-start-before-result', { workflowId });
      return handle;
    };
  };
  mutable.send = async (...args): Promise<unknown> => {
    const message = args[1];
    if (isRecord(message) && message.preDispatchCancelled === true) {
      await freezeAtFault('before-pre-dispatch-cancellation-relay');
    }
    return await originalSend(...args);
  };

  mutable.runStep = async (...args): Promise<unknown> => {
    const name = stringOption(args[1], 'name');
    if (name?.startsWith('script-dispatch-intent:') === true) {
      await freezeAtFault('before-script-dispatch-intent-commit');
    }
    if (name?.startsWith('script-provider-') === true) {
      await freezeAtFault('before-script-provider-decision');
    }
    const result = await originalRunStep(...args);
    if (name?.startsWith('script-dispatch-intent:') === true) {
      await freezeAtFault('after-script-dispatch-intent');
    }
    if (name?.startsWith('script-provider-') === true) {
      await freezeAtFault('after-script-provider-step');
    }
    if (name === 'kernel.advance') {
      await freezeAtFault('after-kernel-advance');
    }
    return result;
  };
  mutable.recv = async (...args): Promise<unknown> => {
    if (args[0] === 'revo-run.coordinator') {
      await freezeAtFault('before-coordinator-receive');
    }
    return await originalReceive(...args);
  };
  mutable.setEvent = async (...args): Promise<unknown> => {
    const result = await originalSetEvent(...args);
    if (
      args[0] === 'revo-run.details' &&
      isRecord(args[1]) &&
      Array.isArray(args[1].attempts) &&
      args[1].attempts.some(
        (attempt) =>
          isRecord(attempt) &&
          (attempt.status === 'succeeded' ||
            attempt.status === 'failed' ||
            attempt.status === 'cancelled' ||
            attempt.status === 'timed_out'),
      )
    ) {
      await freezeAtFault('after-script-terminal-persisted');
    }
    return result;
  };
};

let composition: RunComposition | undefined;

try {
  const fence = new RunHostReadinessFence();
  installProcessPauseBoundaries();
  composition = {
    fence,
    agents: unavailableAgentPort,
    scripts,
  };
  installRunComposition(composition);
  DBOS.setConfig({
    name: 'revo-run-script-dispatch-recovery-test',
    systemDatabaseUrl: databaseUrl,
  });
  await DBOS.launch();
  send('launched');
  if (mode !== 'recover-closed') {
    fence.open();
  }
  if (mode === 'start') {
    const admitted = await admitRun(input, composition);
    await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: runWorkflowId(runId) })(admitted);
  }
  if (mode === 'recover-closed') {
    await new Promise<void>(() => undefined);
  }
  const result = await DBOS.retrieveWorkflow<KernelRunResult>(runWorkflowId(runId)).getResult();
  const eventTypes: string[] = [];
  const scriptEventNames: string[] = [];
  for await (const event of DBOS.readStream<{ readonly payload: { readonly type: string } }>(
    runWorkflowId(runId),
    'revo-run.events',
  )) {
    eventTypes.push(event.payload.type);
    if (
      event.payload.type === 'script.event' &&
      typeof event.payload === 'object' &&
      event.payload !== null &&
      'event' in event.payload &&
      typeof event.payload.event === 'object' &&
      event.payload.event !== null &&
      'name' in event.payload.event &&
      typeof event.payload.event.name === 'string'
    ) {
      scriptEventNames.push(event.payload.event.name);
    }
  }
  send('terminal', { result, eventTypes, scriptEventNames });
  await DBOS.shutdown();
  clearRunComposition(composition);
  composition = undefined;
  process.exit(0);
} catch (error) {
  send('error', { message: error instanceof Error ? error.message : String(error) });
  await DBOS.shutdown().catch(() => undefined);
  if (composition !== undefined) {
    clearRunComposition(composition);
  }
  process.exit(1);
}
