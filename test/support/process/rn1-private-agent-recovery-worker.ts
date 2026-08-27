import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { compilePipeline, type PipelineSourcePackage } from '@revisium/revo-pipeline';
import { createInitialPipelineState } from '@revisium/revo-pipeline/kernel';
import { createRevoScripts } from '@revisium/revo-scripts';

import type {
  AgentInvocationResult,
  StartAgentInvocation,
  PreparedAgentBinding,
} from '../../../src/composition/agent-port.js';
import { RunHostReadinessFence } from '../../../src/composition/readiness-fence.js';
import {
  clearRunComposition,
  installRunComposition,
  type RunComposition,
} from '../../../src/composition/run-composition.js';
import type { AdmittedRunSnapshotV1 } from '../../../src/contracts/admitted-run.js';
import { kernelRunWorkflow, type KernelRunResult } from '../../../src/dbos/kernel-run-workflow.js';
import { runWorkflowId } from '../../../src/dbos/workflow-id.js';
import { createFakeAgentPort } from '../agent-runtime/fake-agent-port.js';

const databaseUrl = process.env.RN1_TEST_DATABASE_URL;
const runId = process.env.RN1_TEST_RUN_ID;
const mode = process.env.RN1_TEST_MODE;

if (databaseUrl === undefined || runId === undefined || (mode !== 'start' && mode !== 'recover')) {
  throw new Error('RN1 private agent recovery worker has invalid input.');
}

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const inputSchema = {
  type: 'object' as const,
  properties: { prompt: { type: 'string' as const, enum: ['Recover agent.'] } },
  required: ['prompt'],
  additionalProperties: false as const,
};
const outputSchema = {
  type: 'object' as const,
  properties: { decision: { type: 'string' as const, enum: ['approved'] } },
  required: ['decision'],
  additionalProperties: false as const,
};
const pipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-private-agent-recovery',
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
        entry: 'agent',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'agent',
            id: 'agent',
            strategies: [
              { kind: 'single', routes: { succeeded: 'done', failed: 'done', cancelled: 'done' } },
            ],
            input: { prompt: { kind: 'literal', value: 'Recover agent.' } },
            inputSchema,
            outputSchema,
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};
const binding: PreparedAgentBinding = {
  schemaVersion: 'prepared-agent-binding/v1',
  definition: { schemaVersion: 'prepared-agent-definition-snapshot/v1', value: { kind: 'fake' } },
  pin: {
    agentId: 'reviewer',
    agentVersion: '1.0.0',
    definitionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
  },
  parameters: {},
  permissions: {},
  workspaceRef: '/trusted/recovery',
  credentials: {},
};

const succeededResult = (input: StartAgentInvocation): AgentInvocationResult => ({
  schemaVersion: 'agent-invocation-result/v1',
  invocationId: input.invocationId,
  pin: binding.pin,
  launch: { executable: 'private-test-agent', reportedVersion: '1.0.0' },
  acceptedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 0,
  exit: { code: 0, signal: null },
  files: {
    directory: input.output.directory,
    events: 'events.ndjson',
    stdout: 'stdout.log',
    stderr: 'stderr.log',
    result: 'result.json',
  },
  status: 'succeeded',
  value: { decision: 'approved' },
});

const send = (kind: string, fields: Readonly<Record<string, unknown>> = {}): void => {
  process.send?.({ kind, ...fields });
};

const snapshot = (): AdmittedRunSnapshotV1 => {
  const compilation = compilePipeline(pipeline, {
    agent: { strategy: 'single', participant: { key: 'reviewer', bindingKey: 'reviewer' } },
  });
  if (!compilation.ok) {
    throw new Error(
      `Private agent recovery fixture did not compile: ${JSON.stringify(compilation.diagnostics)}`,
    );
  }
  const initial = createInitialPipelineState(
    { program: compilation.program, programDigest: compilation.programDigest },
    {},
  );
  if (initial.state.status === 'failed') {
    throw new Error('Private agent recovery fixture did not initialize.');
  }
  return {
    persistenceVersion: 1,
    runId,
    raw: {
      pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {
          agent: { strategy: 'single', participant: { key: 'reviewer', bindingKey: 'reviewer' } },
        },
        bindings: {
          agents: {
            reviewer: {
              definition: { id: 'reviewer', version: '1.0.0' },
              parameters: {},
              permissions: {},
              workspaceRef: 'private-agent-recovery',
            },
          },
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
    bindings: { scripts: {}, agents: { reviewer: binding } },
    initial: { state: initial.state, commands: initial.commands },
    admission: { createdAt: new Date().toISOString(), token: randomUUID() },
  };
};

let composition: RunComposition | undefined;
try {
  const fence = new RunHostReadinessFence();
  const fake = createFakeAgentPort(succeededResult);
  const port = {
    ...fake.port,
    start: async (...args: Parameters<typeof fake.port.start>) => {
      const handle = await fake.port.start(...args);
      send('start', { invocationId: handle.invocationId });
      if (mode === 'start') {
        send('accepted');
        await new Promise<void>(() => undefined);
      }
      return handle;
    },
    getResult: (...args: Parameters<typeof fake.port.getResult>) => {
      send('lookup', { invocationId: args[0] });
      return { state: 'unknown' } as const;
    },
  };
  composition = {
    fence,
    agents: port,
    scripts: createRevoScripts({
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Unexpected script workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Unexpected script credential.');
          },
        },
      },
    }),
  };
  installRunComposition(composition);
  DBOS.setConfig({ name: 'revo-run-private-agent-recovery-test', systemDatabaseUrl: databaseUrl });
  await DBOS.launch();
  fence.open();
  if (mode === 'start') {
    await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: runWorkflowId(runId) })(snapshot());
  }
  const result = await DBOS.retrieveWorkflow<KernelRunResult>(runWorkflowId(runId)).getResult();
  send('terminal', { result });
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
