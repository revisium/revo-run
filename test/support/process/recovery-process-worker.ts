import type {
  RunExecutor,
  RunExecutorContext,
  RunExecutorRequest,
  RunExecutorResult,
} from '../../../src/index.js';
import { createRunManager } from '../../../src/index.js';
import { recoveryExecutionPlan } from './recovery-execution-plan.fixture.js';

type WorkerCommand = { readonly kind: 'complete'; readonly path: string };

const environment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const send = (message: object): void => {
  process.send?.(message);
};

class ProcessRunExecutor implements RunExecutor {
  private readonly pending = new Map<string, Array<(result: RunExecutorResult) => void>>();
  private readonly scenario: string;

  constructor(scenario: string) {
    this.scenario = scenario;
  }

  execute(request: RunExecutorRequest, context: RunExecutorContext): Promise<RunExecutorResult> {
    send({ kind: 'dispatched', path: request.path });
    if (this.scenario === 'timeout' && request.path === 'main/work') {
      return new Promise(() => {
        context.signal.addEventListener('abort', () => {
          send({ kind: 'timeoutSignalled', path: request.path });
        });
      });
    }

    return new Promise((resolve) => {
      const pending = this.pending.get(request.path) ?? [];
      pending.push(resolve);
      this.pending.set(request.path, pending);
    });
  }

  complete(path: string): void {
    const resolve = this.pending.get(path)?.shift();
    if (resolve === undefined) {
      throw new Error(`Execution ${path} is not pending.`);
    }
    resolve({ kind: 'completed', outcome: 'completed' });
  }
}

const scenario = environment('REVO_RUN_TEST_SCENARIO');
const plan = recoveryExecutionPlan(scenario);
const executor = new ProcessRunExecutor(scenario);
const manager = createRunManager({
  database: { url: environment('REVO_RUN_TEST_DATABASE_URL') },
  executor,
});
const runId = environment('REVO_RUN_TEST_RUN_ID');

process.on('message', (message: WorkerCommand) => {
  if (message.kind === 'complete') {
    try {
      executor.complete(message.path);
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
});

await manager.start();
if (environment('REVO_RUN_TEST_MODE') === 'start') {
  await manager.startRun({ runId, executionPlan: plan, input: null });
}

const watchTerminalRun = async (): Promise<void> => {
  const run = await manager.getRun(runId);
  if (run !== undefined && run.status !== 'pending' && run.status !== 'running') {
    send({ kind: 'terminal', status: run.status });
    await manager.stop();
    send({ kind: 'stopped' });
    process.disconnect();
    return;
  }
  setTimeout(() => void watchTerminalRun(), 25);
};

void watchTerminalRun();
