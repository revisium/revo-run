import { randomUUID } from 'node:crypto';

import { createSnapshot } from './snapshot.js';
import type { CreateRunManagerOptions, RunManager } from './types.js';
import { createWorkflowRuntime } from './workflow.js';

let activeManager: symbol | undefined;

export const createRunManager = (options: CreateRunManagerOptions): RunManager => {
  if (activeManager) throw new Error('Only one run manager may be created per process.');
  const runtime = createWorkflowRuntime(options);
  const manager = Symbol('run-manager');
  activeManager = manager;
  let state: 'stopped' | 'starting' | 'started' | 'stopping' | 'failed' = 'stopped';
  let disposed = false;
  let transition = Promise.resolve();
  const release = (): void => {
    disposed = true;
    runtime.dispose();
    if (activeManager === manager) activeManager = undefined;
  };
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
        if (disposed) throw new Error('Run manager has been stopped.');
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
        if (disposed) return;
        if (state === 'stopped') {
          release();
          return;
        }
        state = 'stopping';
        try {
          await runtime.shutdown();
          state = 'stopped';
          release();
        } catch (error: unknown) {
          state = 'failed';
          throw error;
        }
      }),
    startRun: ({ input, planPin }) => {
      const snapshot = createSnapshot(randomUUID(), planPin, input);
      return serialize(async () => {
        if (disposed || state !== 'started') throw new Error('Run manager is not started.');
        return runtime.submit(snapshot);
      });
    },
    getRun: (runId) => options.snapshots.get(runId),
  };
};
