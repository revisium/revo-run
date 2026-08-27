import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    fileParallelism: false,
    // DBOS recovery and fresh-process proofs are intentionally integration
    // tests. V8 instrumentation can make a clean manager launch exceed the
    // default five-second unit-test timeout without changing its semantics.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
