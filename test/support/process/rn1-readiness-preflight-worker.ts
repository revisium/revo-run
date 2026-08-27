import { DBOS } from '@dbos-inc/dbos-sdk';

type WorkerMode = 'recover' | 'start';

interface WorkerCommand {
  readonly kind: 'open' | 'stop';
}

class ReadinessFence {
  private opened: boolean;
  private resolveOpen: (() => void) | undefined;
  private readonly openedPromise: Promise<void>;

  constructor(opened: boolean) {
    this.opened = opened;
    this.openedPromise = new Promise<void>((resolve) => {
      this.resolveOpen = resolve;
    });
  }

  async awaitOpen(): Promise<void> {
    if (!this.opened) {
      await this.openedPromise;
    }
  }

  open(): void {
    if (!this.opened) {
      this.opened = true;
      this.resolveOpen?.();
    }
  }
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const isWorkerMode = (value: string): value is WorkerMode =>
  value === 'recover' || value === 'start';
const configuredMode = requiredEnvironment('REVO_RUN_RN1_PREFLIGHT_MODE');
if (!isWorkerMode(configuredMode)) {
  throw new Error('REVO_RUN_RN1_PREFLIGHT_MODE is invalid.');
}
const mode = configuredMode;
const workflowId = requiredEnvironment('REVO_RUN_RN1_PREFLIGHT_WORKFLOW_ID');
const fence = new ReadinessFence(mode === 'start');

const readinessWorkflow = DBOS.registerWorkflow(
  async () => {
    await fence.awaitOpen();
    process.send?.({ kind: 'dispatch' });
    if (mode === 'start') {
      await new Promise<void>(() => undefined);
    }
    return { status: 'dispatched' as const };
  },
  { name: 'revo-run.rn1-preflight-readiness-root' },
);

DBOS.setConfig({
  name: 'revo-run-rn1-readiness-preflight',
  executorID: 'revo-run-rn1-readiness-preflight',
  systemDatabaseSchemaName: 'dbos_rn1_readiness_preflight',
  systemDatabaseUrl: requiredEnvironment('REVO_RUN_RN1_PREFLIGHT_DATABASE_URL'),
});

await DBOS.launch();
process.send?.({ kind: 'launched' });

if (mode === 'start') {
  await DBOS.startWorkflow(readinessWorkflow, { workflowID: workflowId })();
  process.send?.({ kind: 'started' });
}

process.on('message', (message: WorkerCommand) => {
  if (message.kind === 'open') {
    fence.open();
    void DBOS.retrieveWorkflow(workflowId)
      .getResult()
      .then(async (result) => {
        process.send?.({ kind: 'terminal', result });
        await DBOS.shutdown();
        process.disconnect();
      })
      .catch((error: unknown) => {
        process.send?.({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }
  if (message.kind === 'stop') {
    void DBOS.shutdown().then(() => process.disconnect());
  }
});
