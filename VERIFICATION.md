# Verification Contract

Run before requesting review:

```bash
pnpm db:test:up
pnpm verify
pnpm db:test:down
```

This checks formatting, strict types, type-aware lint, build output, shell syntax, and the real
DBOS lifecycle against the disposable PostgreSQL configured in `.env.test`.
