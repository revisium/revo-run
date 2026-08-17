import { createRunManager } from '../../../src/index.js';
import type { RunExecutor, RunExecutorContext, RunExecutorRequest } from '../../../src/index.js';
import { unknownOutcomePlan } from './package-plans.js';

const databaseUrl = process.env['DATABASE_URL'];
const runId = process.env['PACKAGE_RUN_ID'];
if (databaseUrl === undefined || runId === undefined) {
  throw new Error('DATABASE_URL and PACKAGE_RUN_ID are required.');
}

const started = Promise.withResolvers<void>();
const executor: RunExecutor = {
  async execute(_request: RunExecutorRequest, context: RunExecutorContext) {
    started.resolve();
    return new Promise((_resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error('Executor aborted.'));
        return;
      }
      context.signal.addEventListener(
        'abort',
        () => {
          reject(new Error('Executor aborted.'));
        },
        { once: true },
      );
    });
  },
  async reconcile() {
    return { kind: 'outcomeUnknown' };
  },
};

const manager = createRunManager({
  database: { url: databaseUrl },
  executor,
});

await manager.start();
await manager.startRun({
  runId,
  executionPlan: unknownOutcomePlan(),
  input: null,
});
await started.promise;
process.stdout.write('ready\n');
await new Promise(() => undefined);
