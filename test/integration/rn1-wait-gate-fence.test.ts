import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { createRevoScripts } from '@revisium/revo-scripts';
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
import type { CreateRunInput } from '../../src/contracts/manager.js';
import type { RunDetails } from '../../src/contracts/observation.js';
import { kernelRunWorkflow, type KernelRunResult } from '../../src/dbos/kernel-run-workflow.js';
import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import type { PipelineSourcePackage } from '../../src/index.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const observationGoldenSchema = Type.Object(
  {
    schemaVersion: Type.Literal('rn1-public-observation-context/v1'),
    durationWait: Type.Object(
      { status: Type.Literal('succeeded'), waitStatus: Type.Literal('completed') },
      { additionalProperties: false },
    ),
    deadlineGate: Type.Object(
      { status: Type.Literal('succeeded'), gateStatus: Type.Literal('deadline') },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: true },
);
const rawObservationGolden: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/rn1/public-observation-context.json', import.meta.url), 'utf8'),
);
const observationGolden = Parse(observationGoldenSchema, rawObservationGolden);

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const durationWaitPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-closed-fence-wait',
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
        entry: 'wait',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'wait',
            id: 'wait',
            wait: { kind: 'duration', durationMs: 1 },
            routes: { completed: 'done', cancelled: 'done' },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const deadlineGatePipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-closed-fence-gate',
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
        entry: 'gate',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'humanGate',
            id: 'gate',
            subject: 'Open only after the host is ready.',
            answers: ['approved'],
            authorizationRequirements: [],
            payloadSchema: null,
            deadline: { afterMs: 1, target: 'done' },
            routes: { answers: [{ answer: 'approved', target: 'done' }], cancelled: 'done' },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

let composition: RunComposition | undefined;

afterEach(async () => {
  await DBOS.shutdown().catch(() => undefined);
  if (composition !== undefined) {
    clearRunComposition(composition);
  }
  composition = undefined;
});

const startWithClosedFence = async (
  pipeline: PipelineSourcePackage,
): Promise<{
  readonly fence: RunHostReadinessFence;
  readonly rootWorkflowId: string;
}> => {
  const fence = new RunHostReadinessFence();
  composition = {
    fence,
    agents: unavailableAgentPort,
    scripts: createRevoScripts({
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Wait/gate readiness fixtures do not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Wait/gate readiness fixtures do not acquire a credential.');
          },
        },
      },
    }),
  };
  installRunComposition(composition);
  DBOS.setConfig({ name: 'revo-run-wait-gate-fence-test', systemDatabaseUrl: testDatabaseUrl() });
  await DBOS.launch();
  const runId = `rn1-closed-fence-${randomUUID()}`;
  const input: CreateRunInput = {
    runId,
    pipeline,
    profile: {
      schemaVersion: 'run-profile/v1',
      selections: {},
      bindings: { agents: {}, scripts: {} },
    },
    input: {},
  };
  const admitted = await admitRun(input, composition);
  const rootWorkflowId = runWorkflowId(runId);
  await DBOS.startWorkflow(kernelRunWorkflow, { workflowID: rootWorkflowId })(admitted);
  return { fence, rootWorkflowId };
};

const detailsBeforeFenceOpens = async (rootWorkflowId: string): Promise<RunDetails | null> =>
  await DBOS.getEvent<RunDetails>(rootWorkflowId, 'revo-run.details', { timeoutSeconds: 0 });

describe('RN1 wait and gate readiness fence', () => {
  it.each([
    [
      'duration wait',
      durationWaitPipeline,
      'waits',
      observationGolden.durationWait.status,
      observationGolden.durationWait.waitStatus,
    ],
    [
      'deadline gate',
      deadlineGatePipeline,
      'gates',
      observationGolden.deadlineGate.status,
      observationGolden.deadlineGate.gateStatus,
    ],
  ] as const)(
    'does not begin the %s child operation until the host fence opens',
    async (_label, pipeline, field, expectedRunStatus, expectedStatus) => {
      const active = await startWithClosedFence(pipeline);

      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(detailsBeforeFenceOpens(active.rootWorkflowId)).resolves.toBeNull();

      active.fence.open();
      const result = await DBOS.retrieveWorkflow<KernelRunResult>(
        active.rootWorkflowId,
      ).getResult();
      expect(result.snapshot).toMatchObject({ status: expectedRunStatus });
      expect(result.details[field]).toMatchObject([
        expect.objectContaining({ status: expectedStatus }),
      ]);
    },
  );
});
