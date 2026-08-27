import type { CreateRunManagerOptions } from '../contracts/manager.js';
import { DefaultRunManager } from './run-manager.js';

export const createRunManager = (options: CreateRunManagerOptions): DefaultRunManager =>
  new DefaultRunManager(options);
