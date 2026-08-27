import { DBOS } from '@dbos-inc/dbos-sdk';

const databaseUrl = process.env.RN1_TEST_DATABASE_URL;
const parentWorkflowId = process.env.RN1_TEST_PARENT_WORKFLOW_ID;
const executionId = process.env.RN1_TEST_EXECUTION_ID;
const attemptId = process.env.RN1_TEST_ATTEMPT_ID;
const winner = process.env.RN1_TEST_WINNER;
const pauseAtArbitrationBodyEntry = process.env.RN1_TEST_PAUSE_AT_ARBITRATION_BODY_ENTRY === '1';
const waitForParentRelease = process.env.RN1_TEST_WAIT_FOR_PARENT_RELEASE === '1';

if (
  databaseUrl === undefined ||
  parentWorkflowId === undefined ||
  executionId === undefined ||
  attemptId === undefined ||
  (winner !== 'dispatch_won' && winner !== 'cancel_won')
) {
  throw new Error('RN1 arbitration worker has invalid input.');
}

const originalRegisterWorkflow = DBOS.registerWorkflow.bind(DBOS);

const registerWorkflowWithArbitrationBodyProbe = function <This, Args extends unknown[], Return>(
  body: (this: This, ...args: Args) => Promise<Return>,
  config?: Parameters<typeof DBOS.registerWorkflow>[1],
): (this: This, ...args: Args) => Promise<Return> {
  if (config?.name !== 'revo-run.attempt-dispatch-arbitration/v1') {
    return originalRegisterWorkflow(body, config);
  }
  return originalRegisterWorkflow(async function (this: This, ...args: Args): Promise<Return> {
    process.send?.({ kind: 'arbitration-body-entered' });
    if (pauseAtArbitrationBodyEntry) {
      await new Promise<never>(() => undefined);
    }
    const result = await body.apply(this, args);
    process.send?.({ kind: 'arbitration-body-executed' });
    return result;
  }, config);
};

// Test-process instrumentation only: the interception exists before importing the
// production operation module, which transitively registers the arbitration body.
DBOS.registerWorkflow = registerWorkflowWithArbitrationBodyProbe;
await import('../../../src/dbos/operation-workflow.js');
const { arbitrateAttemptDispatch, attemptDispatchArbitrationCandidate } =
  await import('../../../src/dbos/attempt-dispatch-arbitration.js');

const parentWorkflow = DBOS.registerWorkflow(
  async () =>
    await arbitrateAttemptDispatch(
      attemptDispatchArbitrationCandidate(executionId, attemptId, winner),
    ),
  { name: 'revo-run.rn1-attempt-arbitration-parent' },
);

const waitForRelease = async (): Promise<void> => {
  if (!waitForParentRelease) {
    return;
  }
  await new Promise<void>((resolve) => {
    process.once('message', (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('kind' in message) ||
        message.kind !== 'release'
      ) {
        throw new Error('RN1 arbitration worker received an invalid release message.');
      }
      resolve();
    });
    process.send?.({ kind: 'ready' });
  });
};

try {
  DBOS.setConfig({
    name: 'revo-run-rn1-attempt-arbitration-worker',
    systemDatabaseUrl: databaseUrl,
  });
  await DBOS.launch();
  await waitForRelease();
  const handle = await DBOS.startWorkflow(parentWorkflow, { workflowID: parentWorkflowId })();
  process.send?.({ kind: 'result', result: await handle.getResult() });
  await DBOS.shutdown();
  process.exit(0);
} catch (error) {
  process.send?.({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
  await DBOS.shutdown().catch(() => undefined);
  process.exit(1);
}
