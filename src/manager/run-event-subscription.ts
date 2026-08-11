import type { RunEvent } from '../contracts/run/run-event.js';
import { RunManagerError } from '../contracts/run/run-manager-error.js';

const nextWithAbort = <Value>(
  iterator: AsyncIterator<Value>,
  signal: AbortSignal,
): Promise<IteratorResult<Value>> =>
  new Promise((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted);
      reject(new RunManagerError('run_event_subscription_failed'));
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });

const eventsWithAbort = <Value>(
  iterator: AsyncIterator<Value>,
  signal: AbortSignal,
): AsyncIterable<Value> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => nextWithAbort(iterator, signal),
  }),
});

async function* readEvents(
  source: AsyncIterable<RunEvent>,
  lifecycleSignal: AbortSignal,
): AsyncGenerator<RunEvent> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for await (const event of eventsWithAbort(iterator, lifecycleSignal)) {
      yield event;
    }
  } catch (error) {
    if (
      error instanceof RunManagerError &&
      (error.code === 'invalid_run_event_cursor' || error.code === 'run_not_found')
    ) {
      throw error;
    }
    throw new RunManagerError('run_event_subscription_failed');
  } finally {
    const closing = iterator.return?.(undefined);
    if (lifecycleSignal.aborted) {
      void closing?.catch(() => undefined);
    } else {
      await closing;
    }
  }
}

export const managedRunEventSubscription = (
  source: AsyncIterable<RunEvent>,
  lifecycleSignal: AbortSignal,
): AsyncIterable<RunEvent> => readEvents(source, lifecycleSignal);
