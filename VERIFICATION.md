# Verification Contract

Run `pnpm verify`. It checks formatting, strict types, type-aware lint, unit behavior, real PostgreSQL/DBOS restart/replay, coverage, build, publint, ATTW, exact tarball consumption, root-only exports, deep-import denial, and shell syntax.

The integration gate requires `DATABASE_URL` whose database name exactly matches `REVO_RUN_TEST_DATABASE` and matches `revo_run_test_[a-z0-9_]+`. It never drops a database or application table. CI must provide the isolated database; a local missing database is reported as skipped, not passed.
