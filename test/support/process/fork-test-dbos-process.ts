import { fork } from 'node:child_process';

export interface ForkTestDbosProcessOptions {
  readonly applicationVersion: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export const forkTestDbosProcess = (worker: string, options: ForkTestDbosProcessOptions) => {
  if (options.applicationVersion.trim().length === 0) {
    throw new Error('A DBOS test process application version is required.');
  }

  return fork(worker, {
    env: {
      ...process.env,
      ...options.env,
      DBOS__APPVERSION: options.applicationVersion,
    },
    execArgv: ['--import', 'tsx'],
    silent: true,
  });
};
