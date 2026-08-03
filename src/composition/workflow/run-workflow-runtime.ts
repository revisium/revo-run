import type { RunManagerSnapshot } from '../../manager/index.js';

export interface RunWorkflowRuntime {
  configure(configuration: {
    readonly applicationName: string;
    readonly systemDatabaseUrl: string;
  }): void;
  launch(): Promise<void>;
  shutdown(): Promise<void>;
  startRun(snapshot: RunManagerSnapshot): Promise<RunManagerSnapshot>;
}
