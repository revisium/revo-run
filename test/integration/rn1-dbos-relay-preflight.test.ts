import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDatabaseUrl } from '../support/test-environment.js';

const relayTopic = 'revo-run.rn1-preflight.relay';
const relayStream = 'revo-run.rn1-preflight.events';

interface RelayMessage {
  readonly receipt: string;
  readonly value: string;
}

interface RelayRootInput {
  readonly expectedReceipt: string;
}

interface RelayChildInput {
  readonly rootWorkflowId: string;
  readonly receipt: string;
}

const relayRoot = DBOS.registerWorkflow(
  async ({ expectedReceipt }: RelayRootInput) => {
    const relay = await DBOS.recv<RelayMessage>(relayTopic, { timeoutSeconds: 5 });
    if (relay === null) {
      throw new Error('The relay did not arrive.');
    }
    if (relay.receipt !== expectedReceipt) {
      throw new Error('The relay receipt is not owned by this root workflow.');
    }

    await DBOS.writeStream(relayStream, { kind: 'live', relay });
    const terminalPair = await DBOS.runStep(
      async () => ({
        result: { kind: 'succeeded' as const },
        terminalEvent: { name: 'revo.script.succeeded' as const, receipt: relay.receipt },
      }),
      { name: 'rn1-preflight-terminal-pair' },
    );
    await DBOS.writeStream(relayStream, { kind: 'terminal', terminalPair });
    await DBOS.closeStream(relayStream);
    return terminalPair;
  },
  { name: 'revo-run.rn1-preflight-relay-root' },
);

const relayChild = DBOS.registerWorkflow(
  async ({ rootWorkflowId, receipt }: RelayChildInput) =>
    DBOS.runStep(
      async () => {
        await DBOS.send(
          rootWorkflowId,
          { receipt, value: 'first' } satisfies RelayMessage,
          relayTopic,
          receipt,
        );
        await DBOS.send(
          rootWorkflowId,
          { receipt, value: 'second' } satisfies RelayMessage,
          relayTopic,
          receipt,
        );
        return { receipt };
      },
      { name: 'rn1-preflight-relay-child-step' },
    ),
  { name: 'revo-run.rn1-preflight-relay-child' },
);

beforeAll(async () => {
  DBOS.setConfig({
    name: 'revo-run-rn1-relay-preflight',
    executorID: 'revo-run-rn1-relay-preflight',
    systemDatabaseSchemaName: 'dbos_rn1_relay_preflight',
    systemDatabaseUrl: testDatabaseUrl(),
  });
  await DBOS.launch();
});

afterAll(async () => {
  await DBOS.shutdown();
});

describe('RN1 DBOS relay preflight', () => {
  it('durably relays one explicit-key child-step event into the serialized root stream', async () => {
    const suffix = randomUUID();
    const rootWorkflowId = `rn1-relay-root-${suffix}`;
    const childWorkflowId = `rn1-relay-child-${suffix}`;
    const receipt = `evr_${suffix}`;

    const root = await DBOS.startWorkflow(relayRoot, { workflowID: rootWorkflowId })({
      expectedReceipt: receipt,
    });
    const child = await DBOS.startWorkflow(relayChild, { workflowID: childWorkflowId })({
      rootWorkflowId,
      receipt,
    });

    await expect(child.getResult()).resolves.toStrictEqual({ receipt });
    await expect(root.getResult()).resolves.toStrictEqual({
      result: { kind: 'succeeded' },
      terminalEvent: { name: 'revo.script.succeeded', receipt },
    });

    const records: unknown[] = [];
    for await (const record of DBOS.readStream(rootWorkflowId, relayStream)) {
      records.push(record);
    }
    expect(records).toStrictEqual([
      { kind: 'live', relay: { receipt, value: 'first' } },
      {
        kind: 'terminal',
        terminalPair: {
          result: { kind: 'succeeded' },
          terminalEvent: { name: 'revo.script.succeeded', receipt },
        },
      },
    ]);

    const replay = await DBOS.startWorkflow(relayRoot, { workflowID: rootWorkflowId })({
      expectedReceipt: receipt,
    });
    await expect(replay.getResult()).resolves.toStrictEqual({
      result: { kind: 'succeeded' },
      terminalEvent: { name: 'revo.script.succeeded', receipt },
    });
  });
});
