# Review Contract

Reject compatibility aliases, deep package entrypoints, a consumer-supplied runner,
or a second pipeline state machine. A packed consumer imports only the package root.

`revo-run` hosts public pipeline commands but does not decide pipeline routes,
parallel settlement, map ordering, repeat bounds, call-stack behavior, or consensus
policy. Those transitions remain in `@revisium/revo-pipeline`. Script resources,
credentials, one-attempt lifecycle, and terminal-result contract remain in
`@revisium/revo-scripts`.

DBOS/PostgreSQL is the only durable store. Reject a second scheduler, projection
database, or external-progress table. The admitted snapshot, command observations,
and root stream must remain sufficient for recovery without recompilation.

Review all public/durable values as closed runtime schemas. They must not expose a
raw pipeline, kernel command/state/event, source profile, secret, absolute path,
live handle, raw provider error, or stack. Public failure values are normalized and
bounded before journal projection.

The startup readiness fence is a required safety boundary: DBOS recovery must not
reach a resolver, script provider, timer delivery, or interaction application before
the composition is initialized. Agent-bearing runs fail closed until the separate
agent adapter is approved.

Root workflow event order and DBOS function IDs are intentional. The exact
`no-await-in-loop` exception for `src/dbos/kernel-run-workflow.ts` preserves that
durable sequence; do not expand it without proving the same DBOS requirement.

Reject a changed function, class, or test that mixes orchestration, domain policy,
provider IO, validation/mapping, and fixture construction. Split by named
responsibility, not line count. Treat a changed source file over 300 lines as a
review signal and require a clear cohesive reason or a semantic extraction.
