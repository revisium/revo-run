# Verification Contract

Run before requesting review:

```bash
pnpm db:test:up
pnpm verify
pnpm db:test:down
```

This checks formatting, strict types, type-aware lint, build output, shell syntax, the packed
tarball (publint, Are the Types Wrong, isolated consumer), and the real DBOS lifecycle against
the disposable PostgreSQL configured in `.env.test`. Release-train and npm-publish run the same
`db:test:up` / `verify` / `db:test:down` sequence because `pnpm verify` needs that database.

Disabled tests are allowed only in `test/acceptance/` and must remain type-safe. Disabled tests
anywhere else fail lint.
