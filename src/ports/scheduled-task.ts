export interface ScheduledTask {
  /** Cancels only the process-local scheduled callback. */
  cancel(): void;
}
