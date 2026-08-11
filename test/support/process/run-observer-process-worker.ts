import { createRunManager } from '../../../src/index.js';
import type { RunEventCursor } from '../../../src/index.js';
import { isRunEventCursor } from '../../../src/validation/run-event-page.validator.js';
import { noopRunExecutor } from '../executor/noop-run-executor.js';

const environment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const optionalCursor = (): RunEventCursor | undefined => {
  const value = process.env.REVO_RUN_TEST_AFTER_CURSOR;
  if (value === undefined) {
    return undefined;
  }
  if (!isRunEventCursor(value)) {
    throw new Error('REVO_RUN_TEST_AFTER_CURSOR is invalid.');
  }
  return value;
};

const manager = createRunManager({
  database: { url: environment('REVO_RUN_TEST_DATABASE_URL') },
  executor: noopRunExecutor,
});
const runId = environment('REVO_RUN_TEST_RUN_ID');

try {
  await manager.start();
  process.send?.({ kind: 'ready' });
  const after = optionalCursor();
  for await (const event of manager.subscribeRunEvents(
    runId,
    after === undefined ? {} : { after },
  )) {
    process.send?.({ kind: 'event', cursor: event.cursor, event, type: event.type });
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      break;
    }
  }
  await manager.stop();
  process.send?.({ kind: 'stopped' });
  process.disconnect();
} catch (error) {
  process.send?.({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
  await manager.stop().catch(() => undefined);
  process.disconnect();
}
