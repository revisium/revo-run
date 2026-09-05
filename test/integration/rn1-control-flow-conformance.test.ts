import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Type } from 'typebox';
import { Parse } from 'typebox/value';
import { afterEach, describe, expect, it } from 'vitest';

import { unavailableAgentPort } from '../../src/composition/agent-port.js';
import { createRunManager, type PipelineSourcePackage, type RunManager } from '../../src/index.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const observationGoldenSchema = Type.Object(
  {
    schemaVersion: Type.Literal('rn1-public-observation-context/v1'),
    terminal: Type.Object(
      {
        status: Type.Literal('succeeded'),
        terminalKind: Type.Literal('succeeded'),
        activityCount: Type.Integer({ minimum: 0 }),
        waitCount: Type.Integer({ minimum: 0 }),
        gateCount: Type.Integer({ minimum: 0 }),
        recoveryCount: Type.Integer({ minimum: 0 }),
      },
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

const endRegion = (key: string, outcome: string) =>
  ({
    key,
    inputSchema: emptySchema,
    entry: `${key}-end`,
    outputSchema: emptySchema,
    exits: [{ outcome, outputSchema: emptySchema }],
    nodes: [{ kind: 'end' as const, id: `${key}-end`, outcome, output: {} }],
  }) as const;

const controlFlowPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-control-flow-conformance',
  entryModule: 'main',
  maximumTotalActivities: 8,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'main-region',
        inputSchema: emptySchema,
        entry: 'choice',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'choice',
            id: 'choice',
            selector: { kind: 'literal', value: true },
            cases: [{ key: 'selected', when: { kind: 'equals', value: true }, target: 'call' }],
            otherwise: 'done',
          },
          {
            kind: 'call',
            id: 'call',
            module: 'child',
            input: {},
            outputSchema: emptySchema,
            routes: {
              outcomes: [{ outcome: 'ok', target: 'parallel' }],
              failed: 'done',
              cancelled: 'done',
            },
          },
          {
            kind: 'parallel',
            id: 'parallel',
            policy: { kind: 'all' },
            remaining: 'drain',
            routes: {
              completed: 'repeat',
              impossible: 'done',
              failed: 'done',
              cancelled: 'done',
            },
            branches: [
              {
                key: 'left',
                input: {},
                region: endRegion('parallel-left', 'ok'),
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
              },
              {
                key: 'right',
                input: {},
                region: endRegion('parallel-right', 'ok'),
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
              },
            ],
          },
          {
            kind: 'repeat',
            id: 'repeat',
            maximumIterations: 2,
            initialInput: {},
            nextInput: {},
            body: endRegion('repeat-body', 'value'),
            bodyExits: [{ outcome: 'value', classification: 'value' }],
            continueWhen: {
              kind: 'exists',
              selector: { kind: 'repeat', value: 'iteration', pointer: '' },
            },
            output: {},
            outputSchema: emptySchema,
            routes: {
              completed: 'map',
              exhausted: 'map',
              failed: 'done',
              cancelled: 'done',
            },
          },
          {
            kind: 'map',
            id: 'map',
            items: { kind: 'literal', value: [{ key: 'only' }] },
            itemKeyPointer: '/key',
            maximumItems: 1,
            maximumConcurrency: 1,
            bodyInput: {},
            body: endRegion('map-body', 'completed'),
            bodyExits: [{ outcome: 'completed', classification: 'completed' }],
            failure: { kind: 'collect' },
            routes: { completed: 'wait', failed: 'done', cancelled: 'done' },
          },
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
    {
      key: 'child',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: endRegion('child-region', 'ok'),
    },
  ],
};

const profile = {
  schemaVersion: 'run-profile/v1' as const,
  selections: {},
  bindings: { agents: {}, scripts: {} },
};

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('RN1 pipeline-kernel conformance', () => {
  it('hosts commands for choice, call, parallel, repeat, map, wait, and end without a second interpreter', async () => {
    manager = createRunManager({
      agents: unavailableAgentPort,
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Control-flow-only pipeline does not acquire a workspace.');
          },
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Control-flow-only pipeline does not acquire a credential.');
          },
        },
      },
    });
    await manager.start();
    const runId = `rn1-control-flow-${randomUUID()}`;

    await expect(
      manager.createRun({ runId, pipeline: controlFlowPipeline, profile, input: {} }),
    ).resolves.toStrictEqual({ runId });
    await expect
      .poll(() => manager?.getRun(runId))
      .toMatchObject({
        status: observationGolden.terminal.status,
        terminal: { kind: observationGolden.terminal.terminalKind, outcome: 'ok', output: {} },
      });
    await expect(manager.getRunDetails(runId)).resolves.toMatchObject({
      activities: [],
      waits: [expect.objectContaining({ kind: 'duration', status: 'completed' })],
      gates: [],
      recovery: [],
    });
    const details = await manager.getRunDetails(runId);
    if (details === undefined) {
      throw new Error('Expected the terminal run details.');
    }
    expect(details.activities).toHaveLength(observationGolden.terminal.activityCount);
    expect(details.waits).toHaveLength(observationGolden.terminal.waitCount);
    expect(details.gates).toHaveLength(observationGolden.terminal.gateCount);
    expect(details.recovery).toHaveLength(observationGolden.terminal.recoveryCount);
  });
});
