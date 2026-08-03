import { randomUUID } from 'node:crypto';

import { createSnapshot } from './snapshot.js';
import type { CreateRunManagerOptions, RunManager } from './types.js';
import { createWorkflowRuntime } from './workflow.js';

let managerCreated = false;

export const createRunManager = (options: CreateRunManagerOptions): RunManager => {
  if (managerCreated) throw new Error('Only one run manager may be created per process.');
  const runtime = createWorkflowRuntime(options);
  managerCreated = true;
  let state: 'stopped' | 'starting' | 'started' | 'stopping' | 'failed' = 'stopped';
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
        if (state === 'failed')
          throw new Error('Run manager shutdown state is uncertain; stop must be retried.');
        state = 'starting';
        try {
          runtime.configure();
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
          state = 'failed';
          throw error;
        }
      }),
    startRun: ({ input, planPin }) => {
      const snapshot = createSnapshot(randomUUID(), planPin, input);
      return serialize(async () => {
        if (state !== 'started') throw new Error('Run manager is not started.');
        return runtime.submit(snapshot);
      });
    },
    getRun: (runId) => options.snapshots.get(runId),
  };
};
