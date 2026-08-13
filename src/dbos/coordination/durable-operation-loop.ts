/** Repeats one durable operation at a time without retaining prior promise chains. */
export const durableOperationLoop = <Value>(
  operation: () => Promise<Value>,
): AsyncIterable<Value> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: false, value: await operation() }),
  }),
});
