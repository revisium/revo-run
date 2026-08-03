import { createRunManagerAdmission, type RunManager } from '../manager/index.js';
import type { CreateRunManagerOptions } from './create-run-manager-options.js';
import { createDbosRunWorkflow } from './workflow/dbos-run-workflow.js';

let managerCreated = false;

export const createRunManager = (options: CreateRunManagerOptions): RunManager => {
  if (managerCreated) throw new Error('Only one run manager may be created per process.');
  const runtime = createDbosRunWorkflow(options.applicationName, options);
  managerCreated = true;
  let state: 'stopped' | 'starting' | 'started' | 'stopping' = 'stopped';
  let transition = Promise.resolve();
  const serialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = transition.then(operation);
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    start: () =>
      serialize(async () => {
        if (state === 'started') return;
        state = 'starting';
        try {
          runtime.configure(options);
          await runtime.launch();
          state = 'started';
        } catch (error: unknown) {
          state = 'stopped';
          throw error;
        }
      }),
    stop: () =>
      serialize(async () => {
        if (state === 'stopped') return;
        state = 'stopping';
        try {
          await runtime.shutdown();
          state = 'stopped';
        } catch (error: unknown) {
          state = 'started';
          throw error;
        }
      }),
    startRun: ({ input, planPin }) => {
      const snapshot = createRunManagerAdmission(options.ids.nextRunId(), planPin, input);
      return serialize(async () => {
        if (state !== 'started') throw new Error('Run manager is not started.');
        return runtime.startRun(snapshot);
      });
    },
    getRun: (runId) => options.snapshots.get(runId),
  };
};
