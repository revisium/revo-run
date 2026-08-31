import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PipelineSourcePackage } from '@revisium/revo-pipeline';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunManager } from '../../src/contracts/manager.js';
import { loadAgentActiveInvocationSnapshots } from '../../src/dbos/agent-active-invocation-registry.js';
import { createRunManager } from '../../src/index.js';
import { codexContextCase } from '../support/codex-conformance.js';
import {
  codexBindingInput,
  createFakeCodexFixture,
  isProcessRunning,
  readFakeCodexCalls,
  removeFakeCodexFixture,
  waitForFakeCodexCalls,
  type FakeCodexFixture,
} from '../support/codex-runtime/fake-codex.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const resultSchema = {
  type: 'object' as const,
  properties: { ok: { type: 'boolean' as const } },
  required: ['ok'],
  additionalProperties: false as const,
};

const pipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-codex-agent-runtime',
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
        entry: 'codex',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'agent',
            id: 'codex',
            strategies: [
              { kind: 'single', routes: { succeeded: 'done', failed: 'done', cancelled: 'done' } },
            ],
            input: { prompt: { kind: 'literal', value: 'Return exact JSON.' } },
            inputSchema: {
              type: 'object',
              properties: { prompt: { type: 'string', enum: ['Return exact JSON.'] } },
              required: ['prompt'],
              additionalProperties: false,
            },
            outputSchema: resultSchema,
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const managers: RunManager[] = [];
const fixtures: FakeCodexFixture[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => await manager.stop()));
  await Promise.all(fixtures.splice(0).map(removeFakeCodexFixture));
  vi.unstubAllEnvs();
});

describe('RN1 Codex DBOS ownership', () => {
  it('CTX-TERMINAL-NO-REPLAY retains one terminal invocation across restart', async () => {
    const context = await codexContextCase('CTX-TERMINAL-NO-REPLAY');
    const fixture = await createFakeCodexFixture('success');
    fixtures.push(fixture);
    const runId = `rn1-codex-agent-${randomUUID()}`;
    const options = {
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => ({
            workspaceId: 'disposable-workspace',
            repositoryId: 'fixture-repository',
          }),
          acquire: fixture.acquire,
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Codex ambient login must not acquire a host credential.');
          },
        },
      },
    } as const;
    const manager = createRunManager(options);
    managers.push(manager);
    await manager.start();

    await manager.createRun({
      runId,
      pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {
          codex: {
            strategy: 'single',
            participant: { key: 'codex', bindingKey: 'codex' },
          },
        },
        bindings: { agents: { codex: codexBindingInput }, scripts: {} },
      },
      input: {},
    });

    expect(await manager.waitForTerminal(runId, { timeoutMs: 10_000 })).toMatchObject({
      status: 'succeeded',
    });
    expect(await waitForFakeCodexCalls(fixture, 2)).toHaveLength(2);
    await manager.stop();
    managers.splice(managers.indexOf(manager), 1);

    const restarted = createRunManager(options);
    managers.push(restarted);
    await restarted.start();

    const restartedSnapshot = await restarted.getRun(runId);
    const invocationCalls = (await readFakeCodexCalls(fixture)).filter(
      ({ args }) => !(args.length === 1 && args[0] === '--version'),
    ).length;
    expect({
      invocationCalls,
      finalStatus: restartedSnapshot?.status,
      replacementInvocationCalls: invocationCalls - 1,
    }).toStrictEqual(context.expected);
  });

  it('CTX-MANAGER-STOP-ORDER reaps active work and acknowledges registry removal before DBOS shutdown', async () => {
    const context = await codexContextCase('CTX-MANAGER-STOP-ORDER');
    const expected = context.expected;
    const fixture = await createFakeCodexFixture('wait');
    fixtures.push(fixture);
    const runId = `rn1-codex-stop-${randomUUID()}`;
    const manager = createRunManager({
      database: { url: testDatabaseUrl() },
      host: {
        resources: { inspect: async () => undefined },
        workspaces: {
          inspect: async () => ({
            workspaceId: 'disposable-workspace',
            repositoryId: 'fixture-repository',
          }),
          acquire: fixture.acquire,
        },
        credentials: {
          inspect: async () => undefined,
          acquire: async () => {
            throw new Error('Codex ambient login must not acquire a host credential.');
          },
        },
      },
    });
    managers.push(manager);
    await manager.start();
    await manager.createRun({
      runId,
      pipeline,
      profile: {
        schemaVersion: 'run-profile/v1',
        selections: {
          codex: {
            strategy: 'single',
            participant: { key: 'codex', bindingKey: 'codex' },
          },
        },
        bindings: { agents: { codex: codexBindingInput }, scripts: {} },
      },
      input: {},
    });
    const pid = (await waitForFakeCodexCalls(fixture, 2))[1]?.pid;
    if (pid === undefined) {
      throw new Error('Expected an active Codex child.');
    }
    await expect.poll(async () => (await loadAgentActiveInvocationSnapshots()).length).toBe(1);

    const orderedEvents = ['public-calls-drained', 'agents.shutdown.begin'];
    let cleanupAfterDbosShutdown = true;
    const originalShutdown = DBOS.shutdown.bind(DBOS);
    vi.spyOn(DBOS, 'shutdown').mockImplementation(async () => {
      expect(isProcessRunning(pid)).toBe(false);
      expect(await loadAgentActiveInvocationSnapshots()).toStrictEqual([]);
      orderedEvents.push('active.remove.ack', 'agents.shutdown.end', 'dbos.shutdown.begin');
      cleanupAfterDbosShutdown = false;
      await originalShutdown();
      orderedEvents.push('dbos.shutdown.end');
    });

    await expect(manager.stop()).resolves.toBeUndefined();
    managers.splice(managers.indexOf(manager), 1);

    expect(isProcessRunning(pid)).toBe(false);
    expect({ orderedEvents, cleanupAfterDbosShutdown }).toStrictEqual(expected);
  }, 20_000);
});
