# ADR 0004: Codex CLI scope and invocation auth correction

## Status

Accepted.

## Amends

ADR 0003.

## Decision

The private Linux Codex route preserves ADR 0003 except for three corrected
boundaries. The root-scoped `--ask-for-approval=never` option precedes `exec`,
while the exec-scoped `--ignore-user-config` option immediately follows it.
`HOME` and `CODEX_HOME` are captured afresh immediately before each
`runtime.start` and supplied only through that invocation's runtime secret
environment and redaction path. A resolved profile containing Codex is rejected
on non-Linux after whole-set resolution but before agent or script preparation,
workspace acquisition, process launch, or DBOS admission; script-only runs are
unchanged.

The executable conformance artifacts own the exact argv, auth-lifetime, and
platform-admission observations. No public API, durable schema, replay policy,
provider policy, or model policy changes.
