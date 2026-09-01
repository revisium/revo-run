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
raw pipeline, kernel command/state/event, source profile, secret, atom-started
absolute POSIX/drive/UNC/device/file-URI token, live handle, raw provider error,
or stack. A non-file URL remains valid only when its full RFC3986 candidate ends
at end-of-text, whitespace, control, or the deterministically selected rightmost
full-valid external wrapper closer. Unknown grammar invalidates the whole
candidate and exposes its first slash. Wrapper characters that are RFC data
remain data unless selected as the maximal valid envelope boundary. Require one
forward O(n) parse with bounded state; reject candidate replay or work multiplied
by wrapper-closer count.
Public failure values are normalized and bounded before journal projection.

The startup readiness fence is a required safety boundary: DBOS recovery must not
reach a resolver, script provider, timer delivery, or interaction application before
the composition is initialized. Unsupported, mixed, or wrongly versioned agent
assignments must fail before workspace acquisition, script preparation, or DBOS
admission. Unknown active agent lookups become `recovery_required`; they never
launch a replacement process.

Agent definitions are discovered and selected through the generic runtime API.
The adapter pins the selected definition and digest, validates configuration in
the runtime session, and keeps acquired workspaces, credentials, and process
handles process-local. Reject unsupported or wrongly versioned assignments
before workspace acquisition, script preparation, process launch, or DBOS
admission. Credential leases remain until terminal settlement and are disposed
on start failure, cancellation, or shutdown.

The private active-invocation registry is one closed, versioned document in the
DBOS system database. Reject a process-local-only sink, a second table/store, a
write that does not await DBOS acknowledgement, or startup that opens readiness
before registry load and runtime identity cleanup. Review terminal success and
failure values through the shared bounded mapper; raw faults and rejected data
must not become durable diagnostics.

Graceful manager stop must close and drain public calls, shut agents down and
await active-registry removal while DBOS remains available, and only then shut
DBOS down. Reject cleanup that first closes DBOS or can return with an orphaned
child.

Root workflow event order and DBOS function IDs are intentional. The exact
`no-await-in-loop` exception for `src/dbos/kernel-run-workflow.ts` preserves that
durable sequence; do not expand it without proving the same DBOS requirement.

Reject a changed function, class, or test that mixes orchestration, domain policy,
provider IO, validation/mapping, and fixture construction. Split by named
responsibility, not line count. Treat a changed source file over 300 lines as a
review signal and require a clear cohesive reason or a semantic extraction.
