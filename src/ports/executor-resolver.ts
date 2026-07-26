import type { ExecutorContractPin } from '../spec/index.js';
import type { ExecutorResolution } from './executor-resolution.js';

export interface ExecutorResolver {
  resolveExact(pin: ExecutorContractPin): Promise<ExecutorResolution>;
}
