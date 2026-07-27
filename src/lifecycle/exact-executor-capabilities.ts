import type { ExecutorResolver } from '../ports/index.js';
import type { ExecutorContractPin } from '../spec/index.js';
import { resolveExactExecutor } from './exact-executor-resolution.js';

interface ExactExecutorCapabilities {
  readonly cancel: CallableFunction | null;
  readonly contractPin: ExecutorContractPin;
  readonly execute: CallableFunction;
  readonly executor: object | ((...arguments_: readonly unknown[]) => unknown);
  readonly reconcile: CallableFunction | null;
}

const maximumPrototypeDepth = 64;

const optionalDataValue = (target: object, key: PropertyKey): unknown => {
  let cursor: object | null = target;
  const visited = new WeakSet<object>();
  let depth = 0;
  while (cursor !== null) {
    if (visited.has(cursor) || depth >= maximumPrototypeDepth) {
      throw new TypeError('Capability prototype chain is unavailable.');
    }
    visited.add(cursor);
    depth += 1;
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError('Accessor capability is unavailable.');
      return descriptor.value;
    }
    const prototype: unknown = Object.getPrototypeOf(cursor);
    if (prototype !== null && typeof prototype !== 'object' && typeof prototype !== 'function') {
      throw new TypeError('Capability prototype is unavailable.');
    }
    cursor = prototype;
  }
  return undefined;
};

export const resolveExactExecutorCapabilities = async (
  resolver: ExecutorResolver,
  pin: ExecutorContractPin,
): Promise<ExactExecutorCapabilities> => {
  const resolution = await resolveExactExecutor(resolver, pin);
  const reconcile = optionalDataValue(resolution.executor, 'reconcile');
  const cancel = optionalDataValue(resolution.executor, 'cancel');
  if (reconcile !== undefined && typeof reconcile !== 'function') {
    throw new TypeError('Executor reconcile is unavailable.');
  }
  if (cancel !== undefined && typeof cancel !== 'function') {
    throw new TypeError('Executor cancel is unavailable.');
  }
  return Object.freeze({
    ...resolution,
    cancel: cancel ?? null,
    reconcile: reconcile ?? null,
  });
};
