const isolatedDatabaseName = /^revo_run_test_[a-z0-9_]+$/;

export const assertIsolatedTestDatabase = (databaseUrl: string): void => {
  const parsed = new URL(databaseUrl);
  const expected = process.env['REVO_RUN_TEST_DATABASE'];
  const configured = decodeURIComponent(parsed.pathname.slice(1));
  if (
    expected === undefined ||
    parsed.protocol !== 'postgresql:' ||
    !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname) ||
    configured !== expected ||
    !isolatedDatabaseName.test(expected)
  ) {
    throw new Error(
      'Refusing DBOS integration tests without an explicit isolated revo_run_test_* database.',
    );
  }
};
