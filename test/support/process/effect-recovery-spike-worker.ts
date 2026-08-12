import { setTimeout as wait } from 'node:timers/promises';

import { DBOS } from '@dbos-inc/dbos-sdk';

import type {
  EffectRecoverySpikeCommand,
  EffectRecoverySpikeInput,
  EffectRecoverySpikeMessage,
  EffectRecoverySpikePhase,
  EffectRecoverySpikeScenario,
  EffectRecoverySpikeScope,
} from './effect-recovery-spike-protocol.js';
import {
  effectRecoveryWaitTopic,
  registerEffectRecoverySpikeWorkflows,
} from './effect-recovery-spike-workflows.js';

const environment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const spikePhase = (): EffectRecoverySpikePhase => {
  const value = environment('REVO_RUN_RR06_SPIKE_PHASE');
  switch (value) {
    case 'recover-complete':
    case 'recover-hold-reconcile':
    case 'recover-timeout':
    case 'start':
      return value;
    default:
      throw new Error('REVO_RUN_RR06_SPIKE_PHASE is invalid.');
  }
};

const spikeScenario = (): EffectRecoverySpikeScenario => {
  const value = environment('REVO_RUN_RR06_SPIKE_SCENARIO');
  switch (value) {
    case 'crash-after-effect':
    case 'crash-before-intent':
    case 'reconcile-crash':
    case 'reconcile-timeout':
    case 'single-wait':
      return value;
    default:
      throw new Error('REVO_RUN_RR06_SPIKE_SCENARIO is invalid.');
  }
};

const spikeScope = (): EffectRecoverySpikeScope => {
  const value = environment('REVO_RUN_RR06_SPIKE_SCOPE');
  switch (value) {
    case 'parallel-child':
    case 'root-execution':
      return value;
    default:
      throw new Error('REVO_RUN_RR06_SPIKE_SCOPE is invalid.');
  }
};

const report = (message: EffectRecoverySpikeMessage): void => {
  process.send?.(message);
};

const phase = spikePhase();
const scope = spikeScope();
const workflowId = environment('REVO_RUN_RR06_SPIKE_WORKFLOW_ID');
const semanticWorkflowId = environment('REVO_RUN_RR06_SPIKE_SEMANTIC_WORKFLOW_ID');
const input: EffectRecoverySpikeInput = {
  attemptId: environment('REVO_RUN_RR06_SPIKE_ATTEMPT_ID'),
  scenario: spikeScenario(),
  semanticWorkflowId,
};
const workflows = registerEffectRecoverySpikeWorkflows(phase, report);

DBOS.setConfig({
  name: 'revo-run-rr06-semantic-spike',
  systemDatabaseUrl: environment('REVO_RUN_RR06_SPIKE_DATABASE_URL'),
});
await DBOS.launch();

process.on('message', (command: EffectRecoverySpikeCommand) => {
  if (command.kind === 'resolveWait') {
    void DBOS.send(semanticWorkflowId, { approved: true }, effectRecoveryWaitTopic).catch(
      (error: unknown) => {
        report({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
  }
});

if (phase === 'start') {
  const workflow = scope === 'root-execution' ? workflows.rootExecution : workflows.parallelParent;
  await DBOS.startWorkflow(workflow, { workflowID: workflowId })(input);
}
report({ kind: 'ready' });

const terminalStatuses = new Set([
  'CANCELLED',
  'ERROR',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
  'SUCCESS',
]);
const reportTerminalWorkflow = async (): Promise<void> => {
  const status = await DBOS.getWorkflowStatus(semanticWorkflowId);
  if (status !== null && terminalStatuses.has(status.status)) {
    report({ kind: 'terminal', status: status.status, output: status.output });
    await DBOS.shutdown();
    report({ kind: 'stopped' });
    process.disconnect();
    return;
  }
  await wait(20);
  return reportTerminalWorkflow();
};

await reportTerminalWorkflow();
