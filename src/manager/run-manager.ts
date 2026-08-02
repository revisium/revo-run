import type { RunSnapshot } from './run-snapshot.js';
import type { StartRunCommand } from './start-run-command.js';

interface StopRunManagerOptions {
  readonly drain?: boolean;
}

export interface RunManager {
  start(): Promise<void>;
  stop(options?: StopRunManagerOptions): Promise<void>;
  startRun(command: StartRunCommand): Promise<RunSnapshot>;
  getRun(runId: string): Promise<RunSnapshot | undefined>;
}
