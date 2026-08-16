import { createRunManager } from '../../../src/index.js';
import type { RunManager } from '../../../src/index.js';
import { humanGateScenarios } from '../../acceptance/scenarios/human-gate.scenarios.js';
import { ControlledRunExecutor } from '../executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../test-environment.js';

interface WorkerMessage {
  readonly kind: 'error' | 'gatePending' | 'stopped' | 'succeeded';
  readonly message?: string;
}

const send = (message: WorkerMessage): void => {
  if (process.send === undefined) {
    throw new Error('Human-gate recovery worker is not a forked process.');
  }
  process.send(message);
};

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
};

const waitForPendingGate = async (manager: RunManager, runId: string): Promise<string> => {
  const deadline = Date.now() + 15_000;
  const poll = async (): Promise<string> => {
    const details = await manager.getRunDetails(runId);
    const gate = details?.gates.find((entry) => entry.status === 'pending');
    if (gate !== undefined) {
      return gate.id;
    }
    if (Date.now() >= deadline) {
      throw new Error('Human gate did not become pending.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return poll();
  };
  return poll();
};

const run = async (): Promise<void> => {
  const phase = requiredEnv('REVO_RUN_TEST_PHASE');
  const runId = requiredEnv('REVO_RUN_TEST_RUN_ID');
  const scenario = humanGateScenarios.find((entry) => entry.intentId === 'rr-043');
  if (scenario === undefined) {
    throw new Error('rr-043 scenario is missing.');
  }
  const manager = createRunManager({
    database: { url: testDatabaseUrl() },
    executor: new ControlledRunExecutor(),
  });
  await manager.start();
  try {
    if (phase === 'wait') {
      await manager.startRun({
        runId,
        executionPlan: scenario.plan,
        input: null,
      });
      await waitForPendingGate(manager, runId);
      send({ kind: 'gatePending' });
      await new Promise(() => undefined);
      return;
    }
    const gateInstanceId = await waitForPendingGate(manager, runId);
    const receipt = await manager.answerGate({
      runId,
      gateInstanceId,
      answer: 'approved',
      actorId: 'alice',
      actorGroups: ['approvers'],
      commandId: `cmd_${crypto.randomUUID()}`,
    });
    if (receipt.status !== 'accepted') {
      throw new Error(`Recovered answer was ${JSON.stringify(receipt)}.`);
    }
    const terminal = await manager.waitForTerminal(runId, { timeoutMs: 15_000 });
    if (terminal.status !== 'succeeded') {
      throw new Error(`Recovered run ended as ${terminal.status}.`);
    }
    send({ kind: 'succeeded' });
  } finally {
    if (phase !== 'wait') {
      await manager.stop();
      send({ kind: 'stopped' });
    }
  }
};

run().catch((error: unknown) => {
  send({
    kind: 'error',
    message: error instanceof Error ? error.message : 'Human-gate recovery worker failed.',
  });
  process.exitCode = 1;
});
