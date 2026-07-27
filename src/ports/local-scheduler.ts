import type { ScheduledTask } from './scheduled-task.js';

export interface LocalScheduler {
  /** Enqueues process-local work without granting durable ownership. */
  enqueue(task: () => void): ScheduledTask;
  /** Waits locally until the delay elapses or the supplied signal aborts. */
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}
