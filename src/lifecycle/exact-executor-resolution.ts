import { snapshotExecutorContractPin } from '../policy/index.js';
import type { ExecutorResolver } from '../ports/index.js';
import type { ExecutorContractPin } from '../spec/index.js';

interface ExactExecutorResolution {
  readonly execute: CallableFunction;
  readonly executor: object | ((...arguments_: readonly unknown[]) => unknown);
  readonly contractPin: ExecutorContractPin;
}

const maximumPrototypeDepth = 64;

const dataValue = (target: object, key: PropertyKey): unknown => {
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
  throw new TypeError('Capability member is unavailable.');
};

const capturedOwnData = (value: unknown): Readonly<Record<string, unknown>> => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    throw new TypeError('Resolution is unavailable.');
  }
  const ownKeys = Reflect.ownKeys(value);
  const captured: Record<string, unknown> = {};
  Object.setPrototypeOf(captured, null);
  for (const key of ownKeys) {
    if (typeof key !== 'string') throw new TypeError('Resolution shape is unavailable.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('Resolution member is unavailable.');
    }
    Object.defineProperty(captured, key, {
      enumerable: true,
      value: descriptor.value,
    });
  }
  return Object.freeze(captured);
};

const hasExactKeys = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

export const resolveExactExecutor = async (
  resolver: ExecutorResolver,
  pin: ExecutorContractPin,
): Promise<ExactExecutorResolution> => {
  const resolverTarget = resolver as object;
  const resolveExact = dataValue(resolverTarget, 'resolveExact');
  if (typeof resolveExact !== 'function') throw new TypeError('Resolver is unavailable.');
  const resolution: unknown = await Reflect.apply(resolveExact, resolver, [
    Object.freeze({ ...pin }),
  ]);
  const resolutionRecord = capturedOwnData(resolution);
  if (
    resolutionRecord['kind'] !== 'resolved' ||
    !hasExactKeys(resolutionRecord, ['kind', 'executor'])
  ) {
    throw new TypeError('Executor is unavailable.');
  }
  const executor = resolutionRecord['executor'];
  if ((typeof executor !== 'object' || executor === null) && typeof executor !== 'function') {
    throw new TypeError('Executor is unavailable.');
  }
  const execute = dataValue(executor, 'execute');
  if (typeof execute !== 'function') throw new TypeError('Executor execute is unavailable.');
  return Object.freeze({
    contractPin: snapshotExecutorContractPin(dataValue(executor, 'contractPin')),
    execute,
    executor,
  });
};
