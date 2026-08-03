import { afterEach, describe, expect, it } from 'vitest';

import { assertIsolatedTestDatabase } from '../support/test-database.js';

describe('integration database guard', () => {
  afterEach(() => delete process.env['REVO_RUN_TEST_DATABASE']);

  it('accepts an exact loopback PostgreSQL test database', () => {
    process.env['REVO_RUN_TEST_DATABASE'] = 'revo_run_test_safe';
    expect(() =>
      assertIsolatedTestDatabase('postgresql://localhost/revo_run_test_safe'),
    ).not.toThrow();
  });

  it.each([
    'http://localhost/revo_run_test_safe',
    'postgresql://database.example/revo_run_test_safe',
    'postgresql://127.0.0.1/production',
  ])('rejects unsafe target %s', (url) => {
    process.env['REVO_RUN_TEST_DATABASE'] = 'revo_run_test_safe';
    expect(() => assertIsolatedTestDatabase(url)).toThrow('Refusing DBOS integration tests');
  });
});
