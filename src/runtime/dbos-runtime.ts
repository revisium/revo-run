import { DBOS } from '@dbos-inc/dbos-sdk';

const applicationName = 'revo-run';

export class DbosRuntime {
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  async start(): Promise<void> {
    DBOS.setConfig({
      name: applicationName,
      systemDatabaseUrl: this.databaseUrl,
    });
    await DBOS.launch();
  }

  async stop(): Promise<void> {
    await DBOS.shutdown();
  }
}
