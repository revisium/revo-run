import { RunManager } from './run-manager.js';

export const createRunManager = (options: {
  readonly database: {
    readonly url: string;
  };
}): RunManager => new RunManager(options.database.url);
