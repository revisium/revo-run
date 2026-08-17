import { fork } from 'node:child_process';

export const forkPackageDbosProcess = (worker: string, env: Readonly<NodeJS.ProcessEnv>) => {
  const applicationVersion = process.env['DBOS__APPVERSION'];
  if (applicationVersion === undefined || applicationVersion.trim().length === 0) {
    throw new Error('DBOS__APPVERSION is required.');
  }

  return fork(worker, {
    env: {
      ...process.env,
      ...env,
      DBOS__APPVERSION: applicationVersion,
    },
    execArgv: ['--import', 'tsx'],
    silent: true,
  });
};
