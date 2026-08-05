import { DbosRuntime } from '../runtime/dbos-runtime.js';

export class RunManager {
  private readonly runtime: DbosRuntime;
  private started = false;

  constructor(databaseUrl: string) {
    this.runtime = new DbosRuntime(databaseUrl);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.runtime.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.runtime.stop();
    this.started = false;
  }
}
