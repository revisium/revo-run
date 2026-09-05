# Repository Contract

`src/index.ts` is the only public entrypoint. It exports the run-manager facade,
closed public schemas, derived types, and the owning pipeline/script types needed
at the root boundary. Deep imports are unsupported.

## Ownership and layout

- `src/admission`: validates raw `pipeline`/`profile`/`input`, compiles exactly
  once, resolves the fixed script bindings, and builds the private admitted
  snapshot.
- `src/contracts`: public JSON schemas, public error catalog, profile contracts,
  and private portable snapshot values. Public timestamps are strings; public or
  durable values never contain `Date`, paths, secrets, or live handles.
- `src/composition`: the startup readiness fence, required injected
  `AgentAttemptExecutionPort`, and the optional generic-runtime adapter.
- `src/operations`: deterministic operation, attempt, wait, gate, and relay
  receipt identities.
- `src/dbos`: the durable kernel host, DBOS workflows, streams, interaction
  records, and recovery/read-model boundary. It may host pipeline command kinds
  but may not interpret pipeline control-flow semantics.
- `src/manager`: consumer lifecycle, creation, observation, and interaction
  facade.
- `test/contracts`: root schemas, admission, IDs, and failure normalization.
- `test/integration`: real DBOS/PostgreSQL behavior, readiness and relay
  preflights, and raw pipeline flows.

`revo-run` does not contain a lowered-plan public boundary, a consumer-provided
executor, a second pipeline interpreter, manually resolved unknown outcomes, or a
consumer-provided runner map. Pipeline control flow remains in
`@revisium/revo-pipeline`; scripts remain in `@revisium/revo-scripts`.
The public Attempt port is one required host boundary, not a runner registry or
the historically banned run-executor abstraction.

The application host owns agent discovery, the process-local `AgentManager`, its
durable active-state sink, initialization from active snapshots, restart reaping,
and manager shutdown. `revo-run` calls the injected port for pipeline Attempts
and owns DBOS lifecycle only. The optional
`createAgentAttemptExecutionAdapter` helper does not own manager lifecycle; host
shutdown drains the manager before adapter shutdown disposes credential leases.
The former package-local DBOS active-invocation registry is not used.

## Durable rules

DBOS/PostgreSQL is the sole durable store. Do not add a package database, Prisma
table, or second scheduler. Immutable workflow input carries the admitted snapshot;
workflow history carries state transitions, operation observations, and public
stream events.

Every externally visible transition is validated at its owning package boundary.
The root host validates relay ownership before publication and does not expose raw
pipeline state, commands, provider errors, or source documents in public details.

The readiness fence is closed before `DBOS.launch()` and checked before external
work so recovered workflows cannot dispatch before the host composition exists.

## Verification

Use [VERIFICATION.md](VERIFICATION.md). Package/consumer checks import only the
packed root entrypoint. Tests that require DBOS use the disposable database from
`.env.test`.
